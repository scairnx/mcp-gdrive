#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerHandlers } from "./handlers.js";
import type { OAuth2Client } from "google-auth-library";
import { loadUserCredentials, createGoogleAuth, listAvailableUsers } from "./auth.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const DEFAULT_USER = process.env.DEFAULT_USER || "scott";

// Cache for auth clients (user ID -> OAuth2Client)
const authCache = new Map<string, any>();

// Session management for SSE transports
const transports: { [sessionId: string]: SSEServerTransport } = {};

/**
 * Get or create OAuth2Client for a specific user
 */
async function getUserAuth(userId: string): Promise<any> {
  // Check cache first
  if (authCache.has(userId)) {
    return authCache.get(userId)!;
  }

  // Load credentials and create auth client
  const credentials = await loadUserCredentials(userId);
  const auth = createGoogleAuth(credentials);

  // Cache it
  authCache.set(userId, auth);

  return auth;
}

/**
 * Extract user ID from request (query param, header, or default)
 */
function getUserIdFromRequest(req: Request): string {
  // Check query parameter: ?user=alice
  if (req.query.user && typeof req.query.user === "string") {
    return req.query.user;
  }

  // Check header: X-GDrive-User: alice
  const headerUser = req.headers["x-gdrive-user"];
  if (headerUser && typeof headerUser === "string") {
    return headerUser;
  }

  // Fall back to default user
  return DEFAULT_USER;
}

/**
 * Create and configure the MCP server for a specific user
 */
function createMcpServer(userId: string): Server {
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

  // Register handlers with user-specific auth provider
  registerHandlers(server, async () => {
    return await getUserAuth(userId);
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

  // Health check endpoint
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "healthy",
      service: "mcp-gdrive-server",
      version: "0.6.2",
      authentication: "none",
      timestamp: new Date().toISOString(),
    });
  });

  // List available users endpoint
  app.get("/users", async (req: Request, res: Response) => {
    try {
      const users = await listAvailableUsers();
      res.json({
        users,
        count: users.length,
        default: DEFAULT_USER,
      });
    } catch (error: any) {
      res.status(500).json({
        error: "Failed to list users",
        message: error.message,
      });
    }
  });

  // MCP endpoint with SSE transport
  app.get("/sse", async (req: Request, res: Response) => {
    const userId = getUserIdFromRequest(req);
    console.error(`New SSE connection established for user: ${userId}`);

    try {
      // Verify user exists
      await getUserAuth(userId);

      const server = createMcpServer(userId);
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
      res.status(400).json({
        error: "Authentication failed",
        message: `User '${userId}' not found or credentials invalid`,
        availableUsers: await listAvailableUsers(),
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
      hint: "Available endpoints: /health, /users, /sse",
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
 * Pre-load and cache auth clients for all available users
 */
async function preloadUsers(): Promise<void> {
  try {
    const users = await listAvailableUsers();

    if (users.length === 0) {
      console.error("⚠️  Warning: No user credentials found!");
      console.error("   Please authenticate users locally first or configure AWS Secrets Manager.");
      console.error("   Run: node dist/index.js auth-user <userId>");
      return;
    }

    console.error(`Found ${users.length} user(s): ${users.join(", ")}`);

    // Pre-load auth clients
    for (const userId of users) {
      try {
        await getUserAuth(userId);
        console.error(`✓ Loaded credentials for user: ${userId}`);
      } catch (error) {
        console.error(`✗ Failed to load credentials for user: ${userId}`);
      }
    }

    // Verify default user exists
    if (!users.includes(DEFAULT_USER)) {
      console.error(`⚠️  Warning: Default user '${DEFAULT_USER}' not found!`);
      console.error(`   Available users: ${users.join(", ")}`);
      console.error(`   Set DEFAULT_USER environment variable to one of the available users.`);
    }
  } catch (error) {
    console.error("Failed to preload users:", error);
  }
}

/**
 * Start the HTTP server
 */
async function main() {
  try {
    console.error("Starting MCP Google Drive HTTP Server (No Auth Required)...");
    console.error(`Environment: ${NODE_ENV}`);
    console.error(`Default user: ${DEFAULT_USER}`);
    console.error("Note: OAuth validation disabled for MCP client compatibility");

    // Pre-load user credentials
    await preloadUsers();

    // Create and start Express app
    const app = await createApp();
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.error(`\nServer listening on port ${PORT}`);
      console.error(`Health check: http://localhost:${PORT}/health`);
      console.error(`List users: http://localhost:${PORT}/users`);
      console.error(`MCP SSE endpoint: http://localhost:${PORT}/sse`);
      console.error(`\nUsage:`);
      console.error(`  - Default user: http://localhost:${PORT}/sse`);
      console.error(`  - Specific user: http://localhost:${PORT}/sse?user=alice`);
      console.error(`  - Or use header: X-GDrive-User: alice\n`);
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
