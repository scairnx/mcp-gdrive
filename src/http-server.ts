#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import { registerHandlers } from "./handlers.js";
import { setupOAuthRoutes, oauthMiddleware } from "./oauth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Store transports by session ID for both SSE and Streamable HTTP
const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

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

  // OAuth discovery and authorization endpoints (manual body parsing in handlers)
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

  // MCP endpoint handler function for Streamable HTTP transport
  const mcpHandler = async (req: Request, res: Response) => {
    try {
      // Check for existing session ID
      const sessionId = req.headers["mcp-session-id"] as string;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Check if the transport is of the correct type
        const existingTransport = transports[sessionId];
        if (existingTransport instanceof StreamableHTTPServerTransport) {
          // Reuse existing transport
          transport = existingTransport;
        } else {
          // Transport exists but is not a StreamableHTTPServerTransport
          return res.status(400).json({
            error: "Bad Request",
            message: "Session exists but uses a different transport protocol"
          });
        }
      } else if (!sessionId && req.method === "POST") {
        // Create new transport for initialization request
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            console.error(`StreamableHTTP session initialized with ID: ${sid}`);
            transports[sid] = transport;
          }
        });

        // Set up onclose handler to clean up transport
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            console.error(`Transport closed for session ${sid}`);
            delete transports[sid];
          }
        };

        // Connect the transport to the MCP server
        const server = createMcpServer();
        await server.connect(transport);
      } else {
        // Invalid request - no session ID or not initialization request
        return res.status(400).json({
          error: "Bad Request",
          message: "No valid session ID provided or not an initialization request"
        });
      }

      // Store request object in transport context for auth provider
      (transport as any)._currentRequest = req;

      // Handle the request using Streamable HTTP transport
      await transport.handleRequest(req as any, res as any, req.body);

      // Clean up request context
      delete (transport as any)._currentRequest;
    } catch (error: any) {
      console.error(`MCP endpoint error:`, error);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal Server Error",
          message: NODE_ENV === "development" ? error.message : "An error occurred",
        });
      }
    }
  };

  // MCP endpoint with OAuth authentication middleware
  // Mount on both /mcp and root / so clients can use either URL
  app.use("/mcp", oauthMiddleware);
  app.all("/mcp", mcpHandler);

  // Also mount on root path for clients that use the root URL (e.g., TextQL)
  app.all("/", oauthMiddleware, mcpHandler);

  // ===================================================================
  // DEPRECATED SSE TRANSPORT (Protocol version 2024-11-05)
  // For backward compatibility with older MCP clients
  // ===================================================================

  // SSE endpoint - establishes event stream
  app.get("/sse", oauthMiddleware, async (req: Request, res: Response) => {
    try {
      console.error("SSE: Client connecting to deprecated SSE transport");
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;

      res.on("close", () => {
        console.error(`SSE: Client disconnected, session ${transport.sessionId}`);
        delete transports[transport.sessionId];
      });

      const server = createMcpServer();
      await server.connect(transport);
      console.error(`SSE: Session ${transport.sessionId} established`);
    } catch (error: any) {
      console.error("SSE: Error establishing connection:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to establish SSE connection" });
      }
    }
  });

  // Messages endpoint - receives client messages for SSE transport
  app.post("/messages", oauthMiddleware, async (req: Request, res: Response) => {
    try {
      const sessionId = req.query.sessionId as string;

      if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId query parameter" });
      }

      const transport = transports[sessionId];

      if (!transport) {
        return res.status(400).json({ error: "No transport found for sessionId" });
      }

      if (!(transport instanceof SSEServerTransport)) {
        return res.status(400).json({
          error: "Session exists but uses a different transport protocol"
        });
      }

      await transport.handlePostMessage(req, res, req.body);
    } catch (error: any) {
      console.error("SSE: Error handling message:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to handle message" });
      }
    }
  });

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: `Route ${req.method} ${req.path} not found`,
      hint: "Available endpoints: /health, /oauth/authorize, /mcp, /sse, /messages",
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
    console.error(`Protocol Versions Supported:`);
    console.error(`  - 2025-11-25 (Streamable HTTP)`);
    console.error(`  - 2024-11-05 (SSE - deprecated, for backward compatibility)`);
    console.error("");

    // Create and start Express app
    const app = await createApp();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.error(`\nServer listening on port ${PORT}`);
      console.error(`\n==============================================`);
      console.error(`TRANSPORT OPTIONS:`);
      console.error(`\n1. Streamable HTTP (Protocol 2025-11-25)`);
      console.error(`   Endpoint: /mcp`);
      console.error(`   Methods: GET, POST, DELETE`);
      console.error(`\n2. SSE (Protocol 2024-11-05) - DEPRECATED`);
      console.error(`   Endpoints: /sse (GET), /messages (POST)`);
      console.error(`   For backward compatibility with older clients`);
      console.error(`\n==============================================`);
      console.error(`\nOTHER ENDPOINTS:`);
      console.error(`  Health: http://localhost:${PORT}/health`);
      console.error(`  OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
      console.error(`  OAuth Metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
      console.error(`\nAUTHENTICATION:`);
      console.error(`  OAuth 2.0 (Required for all transports)`);
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

      // Close all active transports
      for (const sessionId in transports) {
        try {
          console.error(`Closing transport for session ${sessionId}`);
          await transports[sessionId].close();
          delete transports[sessionId];
        } catch (error) {
          console.error(`Error closing transport for session ${sessionId}:`, error);
        }
      }

      console.error("All transports closed");
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
