#!/usr/bin/env node

/**
 * Multi-User Authentication CLI Tool
 *
 * This script helps authenticate multiple team members' Google accounts
 * and manage their credentials for the MCP Google Drive server.
 */

import { authenticateUser, listLocalUsers, getDefaultOAuthPath, getCredentialsDirectory } from "../src/auth.js";
import fs from "fs";
import * as readline from "readline/promises";
import { stdin as input, stdout as output } from 'process';

const rl = readline.createInterface({ input, output });

async function showMenu() {
  console.log("\n" + "=".repeat(60));
  console.log("  MCP Google Drive - Multi-User Authentication");
  console.log("=".repeat(60));
  console.log("\n1. Authenticate new user");
  console.log("2. List authenticated users");
  console.log("3. Remove user credentials");
  console.log("4. Check OAuth keys");
  console.log("5. Exit\n");
}

async function authenticateNewUser() {
  console.log("\n--- Authenticate New User ---\n");

  const userId = await rl.question("Enter user ID (e.g., alice, bob, john): ");

  if (!userId || !/^[a-z0-9_-]+$/i.test(userId)) {
    console.log("❌ Invalid user ID. Use only letters, numbers, hyphens, and underscores.");
    return;
  }

  const existingUsers = listLocalUsers();
  if (existingUsers.includes(userId)) {
    const overwrite = await rl.question(`⚠️  User '${userId}' already exists. Overwrite? (yes/no): `);
    if (overwrite.toLowerCase() !== "yes" && overwrite.toLowerCase() !== "y") {
      console.log("Cancelled.");
      return;
    }
  }

  console.log(`\nAuthenticating user '${userId}'...`);
  console.log("This will open your browser for Google authentication.\n");

  try {
    await authenticateUser(userId);
    console.log(`\n✓ User '${userId}' authenticated successfully!`);
  } catch (error: any) {
    console.error(`\n❌ Authentication failed: ${error.message}`);
  }
}

async function listUsers() {
  console.log("\n--- Authenticated Users ---\n");

  const users = listLocalUsers();

  if (users.length === 0) {
    console.log("No users authenticated yet.");
    console.log("Use option 1 to authenticate your first user.");
    return;
  }

  console.log(`Found ${users.length} user(s):\n`);

  const credDir = getCredentialsDirectory();

  for (const userId of users) {
    const credPath = `${credDir}/user-${userId}.json`;
    try {
      const stats = fs.statSync(credPath);
      const modifiedDate = stats.mtime.toISOString().split('T')[0];
      console.log(`  • ${userId} (last modified: ${modifiedDate})`);
    } catch {
      console.log(`  • ${userId}`);
    }
  }

  console.log(`\nCredentials directory: ${credDir}`);
}

async function removeUser() {
  console.log("\n--- Remove User Credentials ---\n");

  const users = listLocalUsers();

  if (users.length === 0) {
    console.log("No users to remove.");
    return;
  }

  console.log("Available users:");
  users.forEach((u, i) => console.log(`  ${i + 1}. ${u}`));

  const userId = await rl.question("\nEnter user ID to remove: ");

  if (!users.includes(userId)) {
    console.log(`❌ User '${userId}' not found.`);
    return;
  }

  const confirm = await rl.question(`⚠️  Remove credentials for '${userId}'? (yes/no): `);

  if (confirm.toLowerCase() !== "yes" && confirm.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  try {
    const credDir = getCredentialsDirectory();
    const credPath = `${credDir}/user-${userId}.json`;
    fs.unlinkSync(credPath);
    console.log(`✓ Removed credentials for user '${userId}'`);
  } catch (error: any) {
    console.error(`❌ Failed to remove credentials: ${error.message}`);
  }
}

async function checkOAuthKeys() {
  console.log("\n--- OAuth Keys Check ---\n");

  const oauthPath = getDefaultOAuthPath();

  if (fs.existsSync(oauthPath)) {
    console.log(`✓ OAuth keys found: ${oauthPath}`);

    try {
      const content = JSON.parse(fs.readFileSync(oauthPath, "utf-8"));
      const hasInstalled = !!content.installed;
      const hasWeb = !!content.web;

      if (hasInstalled) {
        console.log("  Type: Desktop application");
        console.log(`  Client ID: ${content.installed.client_id}`);
      } else if (hasWeb) {
        console.log("  Type: Web application");
        console.log(`  Client ID: ${content.web.client_id}`);
      }
    } catch (error: any) {
      console.log(`⚠️  Failed to parse OAuth keys: ${error.message}`);
    }
  } else {
    console.log(`❌ OAuth keys not found: ${oauthPath}`);
    console.log("\nPlease:");
    console.log("  1. Go to Google Cloud Console");
    console.log("  2. Enable Google Drive API");
    console.log("  3. Create OAuth 2.0 credentials (Desktop app type)");
    console.log("  4. Download and save as: gcp-oauth.keys.json");
  }
}

async function main() {
  console.clear();

  while (true) {
    await showMenu();

    const choice = await rl.question("Select an option (1-5): ");

    switch (choice.trim()) {
      case "1":
        await authenticateNewUser();
        break;

      case "2":
        await listUsers();
        break;

      case "3":
        await removeUser();
        break;

      case "4":
        await checkOAuthKeys();
        break;

      case "5":
        console.log("\nGoodbye! 👋\n");
        rl.close();
        process.exit(0);

      default:
        console.log("\n❌ Invalid option. Please select 1-5.");
    }

    await rl.question("\nPress Enter to continue...");
    console.clear();
  }
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('\n❌ Error:', error.message);
  rl.close();
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n\nInterrupted. Goodbye! 👋\n');
  rl.close();
  process.exit(0);
});

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
