#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { registerHandlers } from "./handlers.js";
import { setupOAuthRoutes, oauthMiddleware } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Single MCP server instance
let mcpServer: Server;
let transport: StreamableHTTPServerTransport;

/**
 * Create and configure the MCP server with OAuth authentication
 */
function createMcpServer(): Server {
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

  // Register handlers with OAuth auth provider
  registerHandlers(server, (req?: Request) => {
    if (!req) {
      throw new Error("Request object required for authentication");
    }

    // Get OAuth authenticated client from request
    const authClient = (req as any).authClient;
    if (!authClient) {
      throw new Error(
        "No OAuth authentication found. Provide Bearer token in Authorization header."
      );
    }

    console.error(`Using OAuth authentication for user: ${(req as any).userId}`);
    return authClient;
  });

  return server;
}

/**
 * Create Express app with Streamable HTTP transport
 */
async function createApp(): Promise<express.Application> {
  // Create Express app without DNS rebinding protection (not needed for 0.0.0.0 binding)
  // DNS rebinding protection is only needed when binding to localhost
  const app = createMcpExpressApp({
    host: "0.0.0.0" // Bind to all interfaces for cloud deployment
  });

  // Enable CORS for all origins (required for browser-based MCP clients)
  app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "HEAD", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "MCP-Session-Id", "MCP-Protocol-Version", "Last-Event-ID"],
    exposedHeaders: ["WWW-Authenticate", "Link", "MCP-Session-Id", "MCP-Protocol-Version"],
    credentials: false,
    maxAge: 86400 // 24 hours
  }));

  // Request logging with details for debugging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ua = req.get('user-agent') || 'none';
    const origin = req.get('origin') || 'none';
    console.error(`${new Date().toISOString()} ${req.method} ${req.path} [origin=${origin}] [ua=${ua.substring(0, 80)}]`);
    next();
  });

  // OAuth discovery and authorization endpoints
  setupOAuthRoutes(app);

  // Health check endpoint (public)
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "healthy",
      service: "mcp-gdrive-server",
      version: "0.6.2",
      authentication: {
        method: "oauth2",
        required: true
      },
      oauth_endpoints: {
        authorize: "/oauth/authorize",
        token: "/oauth/token",
        metadata: "/.well-known/oauth-protected-resource"
      },
      mcp_endpoint: "/mcp",
      protocol_version: "2025-11-25",
      transport: "streamable-http",
      timestamp: new Date().toISOString(),
    });
  });

  // MCP endpoint handler function
  const mcpHandler = async (req: Request, res: Response) => {
    try {
      // Store request object in transport context for auth provider
      (transport as any)._currentRequest = req;

      // Handle the request using Streamable HTTP transport
      await transport.handleRequest(req as any, res as any, req.body);
    } catch (error: any) {
      console.error(`MCP endpoint error:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal Server Error",
          message: NODE_ENV === "development" ? error.message : "An error occurred",
        });
      }
    } finally {
      // Clean up request context
      delete (transport as any)._currentRequest;
    }
  };

  // MCP endpoint with OAuth authentication middleware
  // Mount on both /mcp and root / so clients can use either URL
  app.use("/mcp", oauthMiddleware);
  app.all("/mcp", mcpHandler);

  // Also mount on root path for clients that use the root URL (e.g., TextQL)
  app.all("/", oauthMiddleware, mcpHandler);

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
      hint: "Available endpoints: /health, /oauth/authorize, /mcp",
    });
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Internal Server Error",
        message: NODE_ENV === "development" ? err.message : "An error occurred",
      });
    }
  });

  return app;
}

/**
 * Start the HTTP server
 */
async function main() {
  try {
    console.error("Starting MCP Google Drive HTTP Server with OAuth 2.0 Authentication...");
    console.error(`Environment: ${NODE_ENV}`);
    console.error(`Protocol Version: 2025-11-25 (Streamable HTTP)`);
    console.error("");

    // Create MCP server
    mcpServer = createMcpServer();

    // Create Streamable HTTP transport with stateful sessions
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Enhance auth provider to get request from transport context
    const originalAuthProvider = (mcpServer as any)._authProvider;
    (mcpServer as any)._authProvider = () => {
      const req = (transport as any)._currentRequest;
      return originalAuthProvider(req);
    };

    // Connect server to transport
    await mcpServer.connect(transport);

    console.error("✓ MCP Server connected to Streamable HTTP transport");
    console.error("");

    // Create and start Express app
    const app = await createApp();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.error(`\nServer listening on port ${PORT}`);
      console.error(`\nEndpoints:`);
      console.error(`  Health: http://localhost:${PORT}/health`);
      console.error(`  MCP: http://localhost:${PORT}/mcp`);
      console.error(`  OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
      console.error(`  OAuth Metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
      console.error(`\nAuthentication:`);
      console.error(`  OAuth 2.0 (Required)`);
      console.error(`    1. Visit http://localhost:${PORT}/oauth/authorize to authenticate`);
      console.error(`    2. Copy the access token from the success page`);
      console.error(`    3. MCP clients will use OAuth 2.0 flow automatically`);
      console.error(``);
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.error("Shutting down gracefully...");
      server.close(() => {
        console.error("HTTP server closed");
      });
      await mcpServer.close();
      await transport.close();
      console.error("MCP server and transport closed");
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
main().catch(console.error);
