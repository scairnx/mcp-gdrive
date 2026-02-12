#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import {
  authenticateAndSaveCredentials,
  authenticateUser,
  loadUserCredentials,
  initializeGoogleAuth,
  listLocalUsers,
} from "./src/auth.js";
import { registerHandlers } from "./src/handlers.js";

/**
 * Display usage information
 */
function showUsage() {
  console.log(`
MCP Google Drive Server - stdio mode

Usage:
  node dist/index.js                    Start server (stdio mode, single-account)
  node dist/index.js auth               Authenticate with Google (single-account legacy)
  node dist/index.js auth-user <userId> Authenticate a specific user (multi-account)
  node dist/index.js list-users         List authenticated users

Examples:
  # Authenticate your first user:
  node dist/index.js auth-user alice

  # Authenticate additional team members:
  node dist/index.js auth-user bob
  node dist/index.js auth-user charlie

  # List all authenticated users:
  node dist/index.js list-users

  # Run server (uses 'default' user or set GDRIVE_USER=alice):
  node dist/index.js

For HTTP mode (recommended for remote access):
  node dist/src/http-server.js
`);
}

/**
 * Run authentication flow for a user
 */
async function runAuthUser(userId: string) {
  try {
    await authenticateUser(userId);
    console.log(`\n✓ Authentication complete for user: ${userId}`);
    console.log("\nNext steps:");
    console.log(`  1. Run server: node dist/index.js`);
    console.log(`  2. Or use HTTP mode: node dist/src/http-server.js`);
  } catch (error) {
    console.error("Authentication failed:", error);
    process.exit(1);
  }
}

/**
 * List authenticated users
 */
function runListUsers() {
  const users = listLocalUsers();

  if (users.length === 0) {
    console.log("\nNo users authenticated yet.");
    console.log("\nAuthenticate a user with:");
    console.log("  node dist/index.js auth-user <userId>");
    return;
  }

  console.log(`\nAuthenticated users (${users.length}):`);
  users.forEach(u => console.log(`  • ${u}`));
  console.log("");
}

/**
 * Load credentials and run the stdio server
 */
async function runServer() {
  const userId = process.env.GDRIVE_USER || "default";

  try {
    console.error(`Loading credentials for user: ${userId}`);

    // Load user credentials
    const credentials = await loadUserCredentials(userId);
    initializeGoogleAuth(credentials);
    console.error("Credentials loaded successfully.");

    // Create and configure server
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

    registerHandlers(server);

    // Start stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("MCP server running on stdio");
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Main CLI router
const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case "auth":
    // Legacy single-account auth
    authenticateAndSaveCredentials().catch(console.error);
    break;

  case "auth-user":
    if (!arg) {
      console.error("Error: User ID required");
      console.error("Usage: node dist/index.js auth-user <userId>");
      console.error("Example: node dist/index.js auth-user alice");
      process.exit(1);
    }
    runAuthUser(arg);
    break;

  case "list-users":
    runListUsers();
    break;

  case "help":
  case "--help":
  case "-h":
    showUsage();
    break;

  case undefined:
    // No command = run server
    runServer().catch(console.error);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    showUsage();
    process.exit(1);
}
