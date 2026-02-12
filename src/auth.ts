import { SecretsManagerClient, GetSecretValueCommand, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { authenticate } from "@google-cloud/local-auth";
import fs from "fs";
import { google } from "googleapis";
import path from "path";
import { fileURLToPath } from 'url';

export interface GoogleCredentials {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
}

export interface OAuthKeys {
  installed?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  web?: {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
}

/**
 * Get the credentials directory for multi-account storage
 */
export function getCredentialsDirectory(): string {
  return process.env.GDRIVE_CREDENTIALS_DIR || path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../credentials"
  );
}

/**
 * Get the default OAuth keys path (shared across all accounts)
 */
export function getDefaultOAuthPath(): string {
  return process.env.GDRIVE_OAUTH_PATH || path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../gcp-oauth.keys.json",
  );
}

/**
 * Get credentials path for a specific user (local storage)
 */
export function getUserCredentialsPath(userId: string): string {
  const dir = getCredentialsDirectory();
  return path.join(dir, `user-${userId}.json`);
}

/**
 * Get secret name for a specific user (AWS Secrets Manager)
 */
export function getUserSecretName(userId: string): string {
  return `mcp-gdrive/users/${userId}`;
}

/**
 * Load credentials from AWS Secrets Manager
 */
async function loadFromSecretsManager(secretName: string): Promise<string> {
  const region = process.env.AWS_REGION || "us-east-1";
  const client = new SecretsManagerClient({ region });

  try {
    const command = new GetSecretValueCommand({ SecretId: secretName });
    const response = await client.send(command);

    if (response.SecretString) {
      return response.SecretString;
    } else if (response.SecretBinary) {
      return Buffer.from(response.SecretBinary).toString("utf-8");
    }

    throw new Error("Secret value is empty");
  } catch (error) {
    throw new Error(`Failed to load secret ${secretName} from AWS Secrets Manager: ${error}`);
  }
}

/**
 * List available users from AWS Secrets Manager
 */
export async function listAwsUsers(): Promise<string[]> {
  const region = process.env.AWS_REGION || "us-east-1";
  const client = new SecretsManagerClient({ region });

  try {
    const command = new ListSecretsCommand({});
    const response = await client.send(command);

    const userIds: string[] = [];
    const prefix = "mcp-gdrive/users/";

    if (response.SecretList) {
      for (const secret of response.SecretList) {
        if (secret.Name && secret.Name.startsWith(prefix)) {
          const userId = secret.Name.substring(prefix.length);
          userIds.push(userId);
        }
      }
    }

    return userIds.sort();
  } catch (error) {
    console.error("Failed to list users from AWS Secrets Manager:", error);
    return [];
  }
}

/**
 * List available users from local credentials directory
 */
export function listLocalUsers(): string[] {
  const dir = getCredentialsDirectory();

  if (!fs.existsSync(dir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(dir);
    const userIds: string[] = [];

    for (const file of files) {
      if (file.startsWith("user-") && file.endsWith(".json")) {
        const userId = file.substring(5, file.length - 5); // Remove "user-" prefix and ".json" suffix
        userIds.push(userId);
      }
    }

    return userIds.sort();
  } catch (error) {
    console.error("Failed to list local users:", error);
    return [];
  }
}

/**
 * List all available users (both local and AWS)
 */
export async function listAvailableUsers(): Promise<string[]> {
  const localUsers = listLocalUsers();

  // If in AWS environment, also check Secrets Manager
  if (process.env.AWS_REGION || process.env.GDRIVE_USE_AWS) {
    const awsUsers = await listAwsUsers();
    // Combine and deduplicate
    const allUsers = [...new Set([...localUsers, ...awsUsers])];
    return allUsers.sort();
  }

  return localUsers;
}

/**
 * Load Google Drive credentials for a specific user
 * Supports both local file and AWS Secrets Manager
 */
export async function loadUserCredentials(userId: string): Promise<GoogleCredentials> {
  // Try AWS Secrets Manager first if in cloud environment
  if (process.env.AWS_REGION || process.env.GDRIVE_USE_AWS) {
    try {
      const secretName = getUserSecretName(userId);
      console.error(`Loading credentials for user '${userId}' from AWS Secrets Manager`);
      const secretString = await loadFromSecretsManager(secretName);
      return JSON.parse(secretString);
    } catch (error) {
      console.error(`Failed to load from AWS Secrets Manager: ${error}`);
      // Fall through to local file
    }
  }

  // Try local file
  const credentialsPath = getUserCredentialsPath(userId);

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      `Credentials not found for user '${userId}'. ` +
      `Expected at: ${credentialsPath}\n` +
      `Available users: ${listLocalUsers().join(", ") || "none"}`
    );
  }

  console.error(`Loading credentials for user '${userId}' from local file: ${credentialsPath}`);
  return JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
}

/**
 * Load OAuth keys (shared across all users)
 * Supports both local file and AWS Secrets Manager
 */
export async function loadOAuthKeys(): Promise<OAuthKeys> {
  // Check if running in AWS environment (OAuth keys passed as env var from Secrets Manager)
  if (process.env.GDRIVE_OAUTH) {
    console.error("Loading OAuth keys from environment variable (AWS Secrets Manager)");
    return JSON.parse(process.env.GDRIVE_OAUTH);
  }

  // Try AWS Secrets Manager
  if (process.env.AWS_REGION || process.env.GDRIVE_USE_AWS) {
    try {
      const secretString = await loadFromSecretsManager("mcp-gdrive/oauth-keys");
      console.error("Loading OAuth keys from AWS Secrets Manager");
      return JSON.parse(secretString);
    } catch (error) {
      console.error(`Failed to load OAuth from AWS: ${error}`);
      // Fall through to local file
    }
  }

  // Fall back to local file
  const oauthPath = getDefaultOAuthPath();

  if (!fs.existsSync(oauthPath)) {
    throw new Error(
      `OAuth keys not found at ${oauthPath}. Please download from Google Cloud Console or set GDRIVE_OAUTH environment variable.`
    );
  }

  console.error(`Loading OAuth keys from local file: ${oauthPath}`);
  return JSON.parse(fs.readFileSync(oauthPath, "utf-8"));
}

/**
 * Create an OAuth2 client with specific credentials
 */
export function createGoogleAuth(credentials: GoogleCredentials) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials(credentials);
  return auth;
}

/**
 * Initialize Google API with credentials (sets as default)
 * @deprecated Use createGoogleAuth instead for multi-user scenarios
 */
export function initializeGoogleAuth(credentials: GoogleCredentials) {
  const auth = createGoogleAuth(credentials);
  google.options({ auth });
  return auth;
}

/**
 * Run authentication flow and save credentials for a specific user
 */
export async function authenticateUser(userId: string): Promise<void> {
  const oauthPath = getDefaultOAuthPath();
  const credentialsDir = getCredentialsDirectory();
  const credentialsPath = getUserCredentialsPath(userId);

  // Ensure credentials directory exists
  if (!fs.existsSync(credentialsDir)) {
    fs.mkdirSync(credentialsDir, { recursive: true });
    console.log(`Created credentials directory: ${credentialsDir}`);
  }

  console.log(`\nAuthenticating user: ${userId}`);
  console.log("Launching auth flow (this will open your browser)...\n");

  const auth = await authenticate({
    keyfilePath: oauthPath,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  fs.writeFileSync(credentialsPath, JSON.stringify(auth.credentials, null, 2));
  console.log(`✓ Credentials saved for user '${userId}'`);
  console.log(`  Location: ${credentialsPath}`);
  console.log("\nYou can now run the server with this user account.");
}

/**
 * Backward compatibility: authenticate and save to default location
 * @deprecated Use authenticateUser with a userId instead
 */
export async function authenticateAndSaveCredentials(): Promise<void> {
  console.log("⚠️  Note: This uses single-account mode. Consider using 'auth-user' with a user ID for multi-account support.\n");
  await authenticateUser("default");
}
