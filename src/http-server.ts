#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import { registerHandlers } from "./handlers.js";
import type { OAuth2Client } from "google-auth-library";
import {
  getProtectedResourceMetadata,
  oauthMiddleware,
  getAuthFromRequest,
} from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

/**
 * Create and configure the MCP server with OAuth auth provider
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

  // Register handlers with OAuth token from request
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

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    console.error(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  // OAuth middleware - validates Bearer tokens
  app.use(oauthMiddleware);

  // Protected Resource Metadata endpoint (RFC9728)
  app.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
    res.json(getProtectedResourceMetadata());
  });

  // Health check endpoint
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "healthy",
      service: "mcp-gdrive-server",
      version: "0.6.2",
      oauth: "enabled",
      authorization_server: "https://accounts.google.com",
      timestamp: new Date().toISOString(),
    });
  });

  // MCP endpoint with SSE transport (OAuth protected)
  app.get("/sse", async (req: Request, res: Response) => {
    console.error(`New SSE connection established`);

    try {
      // Auth client is attached to request by oauthMiddleware
      const server = createMcpServer(req);
      const transport = new SSEServerTransport("/message", res);

      await server.connect(transport);

      // Handle client disconnect
      req.on("close", () => {
        console.error(`SSE connection closed`);
        server.close();
      });
    } catch (error: any) {
      console.error(`Failed to establish SSE connection:`, error);
      res.status(500).json({
        error: "Connection failed",
        message: error.message,
      });
    }
  });

  // MCP message endpoint (POST for client messages)
  app.post("/message", async (req: Request, res: Response) => {
    // This endpoint receives messages from the client
    // The SSEServerTransport handles routing these to the server
    console.error("Received message from client");
    res.status(202).json({ received: true });
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
      hint: "Available endpoints: /.well-known/oauth-protected-resource, /health, /sse",
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
    console.error("Starting MCP Google Drive HTTP Server (OAuth 2.0)...");
    console.error(`Environment: ${NODE_ENV}`);
    console.error("Authentication: OAuth 2.0 with Google");

    // Create and start Express app
    const app = await createApp();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.error(`\nServer listening on port ${PORT}`);
      console.error(`OAuth Metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
      console.error(`Health check: http://localhost:${PORT}/health`);
      console.error(`MCP SSE endpoint: http://localhost:${PORT}/sse`);
      console.error(`\nAuthentication: OAuth 2.0 Bearer tokens required`);
      console.error(`Authorization Server: https://accounts.google.com\n`);
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
