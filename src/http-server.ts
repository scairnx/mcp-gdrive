#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerHandlers } from "./handlers.js";
import { setupOAuthRoutes, oauthMiddleware, getAuthFromRequest } from "./oauth.js";
import { loadUserCredentials, createGoogleAuth } from "./auth.js";
import { google } from "googleapis";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

// Session management for SSE transports
const transports: { [sessionId: string]: SSEServerTransport } = {};

// Pre-authenticated credentials (shared across sessions when not using OAuth)
let preAuthClient: InstanceType<typeof google.auth.OAuth2> | null = null;
let preAuthUserId: string | null = null;

/**
 * Load pre-authenticated credentials if available
 */
async function loadPreAuthCredentials(): Promise<void> {
  try {
    // Try to load from environment variable first (AWS Secrets Manager)
    if (process.env.GDRIVE_CREDENTIALS) {
      console.error("Loading pre-authenticated credentials from environment variable");
      const credentials = JSON.parse(process.env.GDRIVE_CREDENTIALS);
      preAuthClient = createGoogleAuth(credentials);
      preAuthUserId = "service-account";
      console.error("✓ Pre-authenticated credentials loaded from environment");
      return;
    }

    // Try to load from user credentials file
    const userId = process.env.GDRIVE_USER || "default";
    console.error(`Attempting to load pre-authenticated credentials for user: ${userId}`);
    const credentials = await loadUserCredentials(userId);
    preAuthClient = createGoogleAuth(credentials);
    preAuthUserId = userId;
    console.error(`✓ Pre-authenticated credentials loaded for user: ${userId}`);
  } catch (error: any) {
    console.error("⚠️  No pre-authenticated credentials available");
    console.error("   To use pre-authenticated mode, either:");
    console.error("   1. Run: node dist/index.js auth-user <userId>");
    console.error("   2. Set GDRIVE_USER environment variable");
    console.error("   3. Set GDRIVE_CREDENTIALS environment variable");
    console.error("");
    console.error("   OAuth mode is still available at /oauth/authorize");
    preAuthClient = null;
    preAuthUserId = null;
  }
}

/**
 * Create and configure the MCP server with hybrid authentication
 * Supports both OAuth Bearer tokens and pre-authenticated credentials
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

  // Register handlers with hybrid auth provider
  registerHandlers(server, () => {
    // Check if request has OAuth authentication
    const authClient = (req as any).authClient;
    if (authClient) {
      console.error(`Using OAuth authentication for user: ${(req as any).userId}`);
      return authClient;
    }

    // Fall back to pre-authenticated credentials
    if (preAuthClient) {
      console.error(`Using pre-authenticated credentials for user: ${preAuthUserId}`);
      return preAuthClient;
    }

    throw new Error(
      "No authentication available. Either provide Bearer token or configure pre-authenticated credentials."
    );
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
    const authMethods = [];
    if (preAuthClient) {
      authMethods.push("pre-authenticated");
    }
    authMethods.push("oauth2");

    res.json({
      status: "healthy",
      service: "mcp-gdrive-server",
      version: "0.6.2",
      authentication: {
        methods: authMethods,
        pre_auth_available: !!preAuthClient,
        pre_auth_user: preAuthUserId || null,
        oauth_available: true
      },
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
    console.error("Starting MCP Google Drive HTTP Server with Hybrid Authentication...");
    console.error(`Environment: ${NODE_ENV}`);
    console.error("");

    // Load pre-authenticated credentials if available
    await loadPreAuthCredentials();
    console.error("");

    // Create and start Express app
    const app = await createApp();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.error(`\nServer listening on port ${PORT}`);
      console.error(`\nEndpoints:`);
      console.error(`  Health: http://localhost:${PORT}/health`);
      console.error(`  MCP SSE: http://localhost:${PORT}/sse`);
      console.error(`  OAuth Authorize: http://localhost:${PORT}/oauth/authorize`);
      console.error(`  OAuth Metadata: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
      console.error(`\nAuthentication Methods:`);

      if (preAuthClient) {
        console.error(`  ✓ Pre-authenticated: User '${preAuthUserId}'`);
        console.error(`    - MCP clients can connect without Bearer token`);
      } else {
        console.error(`  ✗ Pre-authenticated: Not configured`);
        console.error(`    - To enable: Run 'node dist/index.js auth-user <userId>'`);
      }

      console.error(`  ✓ OAuth 2.0: Available`);
      console.error(`    - Visit http://localhost:${PORT}/oauth/authorize`);
      console.error(`    - Copy access token and use: Authorization: Bearer <token>`);
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
