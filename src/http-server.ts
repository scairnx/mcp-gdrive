#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerHandlers } from "./handlers.js";
import { setupOAuthRoutes, oauthMiddleware, getAuthFromRequest } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Session management for SSE transports
const transports: { [sessionId: string]: SSEServerTransport } = {};

/**
 * Create and configure the MCP server with OAuth authentication
 */
function createMcpServer(req: Request): Server {
  const server = new Server(
    {
      name: "mcp-gdrive-server",
      version: "0.6.2",
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // Register handlers with OAuth-based auth provider
  registerHandlers(server, () => {
    return getAuthFromRequest(req);
  });

  return server;
}

/**
 * Create Express app with SSE transport
 */
async function createApp(): Promise<express.Application> {
  const app = express();

  // Middleware
  app.use(express.json());

  // Enable CORS for all origins (required for browser-based MCP clients)
  app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "HEAD"],
    allowedHeaders: ["Content-Type", "Authorization", "X-GDrive-User"],
    exposedHeaders: ["WWW-Authenticate"],
    credentials: false,
    maxAge: 86400 // 24 hours
  }));

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    console.error(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  // OAuth discovery and authorization endpoints
  setupOAuthRoutes(app);

  // OAuth middleware - validates Bearer tokens for protected endpoints
  app.use(oauthMiddleware);

  // Health check endpoint (public)
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "healthy",
      service: "mcp-gdrive-server",
      version: "0.6.2",
      authentication: "oauth2",
      oauth_endpoints: {
        authorize: "/oauth/authorize",
        token: "/oauth/token",
        metadata: "/.well-known/oauth-protected-resource"
      },
      timestamp: new Date().toISOString(),
    });
  });

  // MCP endpoint with SSE transport (OAuth-protected)
  app.get("/sse", async (req: Request, res: Response) => {
    const userId = (req as any).userId || "authenticated-user";
    console.error(`New SSE connection established for user: ${userId}`);

    try {
      const server = createMcpServer(req);
      const transport = new SSEServerTransport("/message", res);

      // Track session for message handling
      transports[transport.sessionId] = transport;
      console.error(`Session created: ${transport.sessionId}`);

      // Handle client disconnect
      res.on("close", () => {
        console.error(`SSE connection closed for user: ${userId}, session: ${transport.sessionId}`);
        delete transports[transport.sessionId];
        server.close();
      });

      await server.connect(transport);
    } catch (error: any) {
      console.error(`Failed to establish SSE connection for user ${userId}:`, error);
      res.status(500).json({
        error: "Connection failed",
        message: error.message
      });
    }
  });

  // MCP message endpoint (POST for client messages)
  app.post("/message", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;

    if (!sessionId) {
      return res.status(400).json({
        error: "Missing sessionId query parameter"
      });
    }

    const transport = transports[sessionId];

    if (!transport) {
      console.error(`Session not found: ${sessionId}`);
      return res.status(404).json({
        error: "Session not found",
        message: "Invalid or expired sessionId"
      });
    }

    try {
      // Handle the message through the transport
      await transport.handlePostMessage(req, res);
    } catch (error: any) {
      console.error(`Error handling message for session ${sessionId}:`, error);
      res.status(500).json({
        error: "Message handling failed",
        message: error.message
      });
    }
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
      hint: "Available endpoints: /health, /oauth/authorize, /sse",
    });
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Error:", err);
    res.status(500).json({
      error: "Internal Server Error",
      message: NODE_ENV === "development" ? err.message : "An error occurred",
    });
  });

  return app;
}

/**
 * Start the HTTP server
 */
async function main() {
  try {
    console.error("Starting MCP Google Drive HTTP Server with OAuth 2.0...");
    console.error(`Environment: ${NODE_ENV}`);

    // Create and start Express app
    const app = await createApp();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.error(`\nServer listening on port ${PORT}`);
      console.error(`\nEndpoints:`);
      console.error(`  Health: http://localhost:${PORT}/health`);
      console.error(`  OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
      console.error(`  OAuth Metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
      console.error(`  MCP SSE: http://localhost:${PORT}/sse`);
      console.error(`\nTo connect:`);
      console.error(`  1. Visit http://localhost:${PORT}/oauth/authorize to authenticate with Google`);
      console.error(`  2. Copy the access token from the success page`);
      console.error(`  3. Use MCP client with: Authorization: Bearer <token>`);
      console.error(``);
    });

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.error("SIGTERM received, shutting down gracefully...");
      server.close(() => {
        console.error("Server closed");
        process.exit(0);
      });
    });

    process.on("SIGINT", () => {
      console.error("SIGINT received, shutting down gracefully...");
      server.close(() => {
        console.error("Server closed");
        process.exit(0);
      });
    });

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
main().catch(console.error);
