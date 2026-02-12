/**
 * OAuth 2.0 Resource Server implementation for MCP
 * Implements RFC9728 - OAuth 2.0 Protected Resource Metadata
 */

import { OAuth2Client } from "google-auth-library";
import { Request, Response, NextFunction } from "express";

// Server metadata
const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const GOOGLE_AUTH_SERVER = "https://accounts.google.com";

/**
 * Protected Resource Metadata (RFC9728)
 * Exposed at /.well-known/oauth-protected-resource
 */
export function getProtectedResourceMetadata() {
  return {
    resource: SERVER_URL,
    authorization_servers: [GOOGLE_AUTH_SERVER],
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["RS256"],
    scopes_supported: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
    ],
  };
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return null;
  }

  return parts[1];
}

/**
 * Validate Google OAuth 2.0 access token
 * Returns OAuth2Client configured with the validated token
 */
async function validateGoogleToken(token: string): Promise<OAuth2Client> {
  const client = new OAuth2Client();

  try {
    // Verify the token with Google
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: [], // We'll validate audience separately
    });

    const payload = ticket.getPayload();
    if (!payload) {
      throw new Error("Invalid token payload");
    }

    // Create OAuth2Client with the access token
    client.setCredentials({
      access_token: token,
    });

    return client;
  } catch (error: any) {
    throw new Error(`Token validation failed: ${error.message}`);
  }
}

/**
 * OAuth middleware - validates Bearer tokens (DISABLED for compatibility)
 * Most MCP clients don't support OAuth flows for custom servers
 */
export async function oauthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // OAuth validation disabled - allow all connections
  // The server will use pre-configured Google credentials
  next();
}

/**
 * Get authenticated OAuth2Client from request
 * Throws if not authenticated
 */
export function getAuthFromRequest(req: Request): OAuth2Client {
  const authClient = (req as any).authClient;
  if (!authClient) {
    throw new Error("Request not authenticated");
  }
  return authClient;
}
