/**
 * OAuth 2.0 Resource Server Metadata (RFC 9728)
 * Provides discovery endpoints for MCP clients that require OAuth
 *
 * NOTE: Authentication is NOT enforced - this server uses pre-configured
 * Google credentials. OAuth metadata is provided for client compatibility only.
 */

import { Request, Response } from "express";

/**
 * Get the server's public URL for OAuth metadata
 */
function getServerUrl(req: Request): string {
  // Check if behind a proxy (CloudFront, ALB, etc.)
  const forwardedProto = req.headers['x-forwarded-proto'] as string;
  const forwardedHost = req.headers['x-forwarded-host'] as string;

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  // Fallback to direct connection
  const protocol = req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}`;
}

/**
 * OAuth 2.0 Resource Server Metadata (RFC 9728)
 * Exposed at /.well-known/oauth-protected-resource
 *
 * This tells MCP clients that OAuth is optional/not required
 */
export function handleOAuthMetadata(req: Request, res: Response): void {
  const serverUrl = getServerUrl(req);

  res.json({
    resource: serverUrl,
    // No authorization_servers listed = OAuth not required
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    // Indicate that no scopes are required (authentication is optional)
    scopes_supported: [],
    // Additional metadata
    mcp_version: "2024-11-05",
    authentication_required: false
  });
}

/**
 * Express route handler for OAuth discovery endpoint
 */
export function setupOAuthRoutes(app: any): void {
  // OAuth Protected Resource Metadata endpoint
  app.get('/.well-known/oauth-protected-resource', handleOAuthMetadata);

  // Some clients might also check this endpoint
  app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    res.status(404).json({
      error: "not_found",
      message: "This server does not implement an OAuth authorization server. Authentication is not required."
    });
  });
}
