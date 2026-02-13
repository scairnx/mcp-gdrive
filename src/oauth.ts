/**
 * OAuth 2.0 Authorization Server Implementation
 * Enables users to authenticate with their own Google accounts
 * Implements MCP OAuth specification + Google OAuth 2.0
 */

import { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import { loadOAuthKeys } from "./auth.js";
import crypto from "crypto";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly"
];

// In-memory storage for OAuth state and tokens
// In production, use Redis or a database
const oauthStates = new Map<string, {
  timestamp: number;
  clientId?: string;
  clientRedirectUri?: string;
  clientState?: string;
}>();
const authorizationCodes = new Map<string, {
  timestamp: number;
  tokens: { access_token: string; refresh_token?: string; expiry_date?: number };
}>();
const userTokens = new Map<string, { access_token: string; refresh_token?: string; expiry_date?: number }>();
const registeredClients = new Map<string, { client_id: string; redirect_uris?: string[]; client_name?: string; timestamp: number }>();

/**
 * Get the server's public URL
 * Properly detects HTTPS when behind CloudFront/ALB
 */
function getServerUrl(req: Request): string {
  const host = req.get('host') || req.hostname;

  // Check various headers that indicate the original protocol
  const forwardedProto = req.headers['x-forwarded-proto'] as string;
  const cloudFrontProto = req.headers['cloudfront-forwarded-proto'] as string;
  const forwardedHost = req.headers['x-forwarded-host'] as string;

  // Determine protocol
  let protocol = 'http';

  // If host is cloudfront.net, always use HTTPS
  if (host && host.includes('cloudfront.net')) {
    protocol = 'https';
  }
  // Check forwarded protocol headers
  else if (forwardedProto) {
    protocol = forwardedProto.split(',')[0].trim();
  } else if (cloudFrontProto) {
    protocol = cloudFrontProto;
  } else if (req.secure || req.protocol === 'https') {
    protocol = 'https';
  }

  // Use forwarded host if available, otherwise use request host
  const finalHost = forwardedHost || host;

  return `${protocol}://${finalHost}`;
}

/**
 * Create Google OAuth2 client
 */
async function createOAuthClient(req: Request): Promise<OAuth2Client> {
  const oauthKeys = await loadOAuthKeys();
  const serverUrl = getServerUrl(req);
  const redirectUri = `${serverUrl}/oauth/callback`;

  const keys = oauthKeys.web || oauthKeys.installed;
  if (!keys) {
    throw new Error("Invalid OAuth configuration");
  }

  return new OAuth2Client(
    keys.client_id,
    keys.client_secret,
    redirectUri
  );
}

/**
 * OAuth Protected Resource Metadata (RFC 9728)
 * /.well-known/oauth-protected-resource
 *
 * Points to our own server which proxies Google OAuth metadata
 * This allows TextQL to discover OAuth 2.1 metadata even though
 * Google only exposes OpenID Connect metadata
 */
export function handleOAuthMetadata(req: Request, res: Response): void {
  const serverUrl = getServerUrl(req);

  // RFC 9728: authorization_servers must be full URLs to authorization server metadata
  // Point to /.well-known/oauth-authorization-server per RFC 8414
  res.json({
    resource: serverUrl,
    authorization_servers: [`${serverUrl}/.well-known/oauth-authorization-server`],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES
  });
}

/**
 * OAuth Authorization Server Metadata (RFC 8414)
 * /.well-known/oauth-authorization-server
 *
 * Acts as OAuth authorization server proxy for Google Drive.
 * MCP clients (like TextQL) can complete the full OAuth dance through our server.
 */
export async function handleAuthServerMetadata(req: Request, res: Response): Promise<void> {
  const serverUrl = getServerUrl(req);

  // Point to OUR endpoints - we proxy the OAuth flow to Google
  res.json({
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/oauth/authorize`,
    token_endpoint: `${serverUrl}/oauth/token`,
    registration_endpoint: `${serverUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: SCOPES
  });
}

/**
 * OAuth Authorization Endpoint
 * GET /oauth/authorize
 *
 * Accepts authorization request from MCP client (e.g., TextQL)
 * Redirects user to Google's OAuth consent screen
 * Stores client's redirect_uri to send them the authorization code later
 */
export async function handleAuthorize(req: Request, res: Response): Promise<any> {
  try {
    const clientRedirectUri = req.query.redirect_uri as string;
    const clientState = req.query.state as string;
    const responseType = req.query.response_type as string;

    // Validate required OAuth parameters
    if (responseType && responseType !== "code") {
      return res.status(400).json({
        error: "unsupported_response_type",
        error_description: "Only 'code' response type is supported"
      });
    }

    const oauth2Client = await createOAuthClient(req);

    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString("hex");
    oauthStates.set(state, {
      timestamp: Date.now(),
      clientId: req.query.client_id as string,
      clientRedirectUri: clientRedirectUri, // Store where to redirect back
      clientState: clientState // Store client's state to return it
    });

    // Clean up old states (older than 10 minutes)
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of oauthStates.entries()) {
      if (value.timestamp < tenMinutesAgo) {
        oauthStates.delete(key);
      }
    }

    // Generate authorization URL to redirect to Google
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      state: state,
      prompt: "consent" // Force consent screen to get refresh token
    });

    console.error(`OAuth authorize: redirecting to Google (client redirect: ${clientRedirectUri})`);
    res.redirect(authUrl);
  } catch (error: any) {
    console.error("Authorization error:", error);
    res.status(500).json({
      error: "server_error",
      error_description: error.message
    });
  }
}

/**
 * OAuth Callback Endpoint
 * GET /oauth/callback
 *
 * Receives authorization code from Google and exchanges for tokens
 * If this was initiated by an MCP client (TextQL), redirects back with our own code
 * Otherwise, displays the access token for manual use
 */
export async function handleCallback(req: Request, res: Response): Promise<any> {
  try {
    const { code, state, error } = req.query;

    // Check for errors from OAuth provider
    if (error) {
      return res.status(400).send(`
        <html>
          <body>
            <h1>Authorization Failed</h1>
            <p>Error: ${error}</p>
            <p>Description: ${req.query.error_description || 'No description provided'}</p>
          </body>
        </html>
      `);
    }

    // Validate state
    if (!state || typeof state !== "string" || !oauthStates.has(state)) {
      return res.status(400).send(`
        <html>
          <body>
            <h1>Authorization Failed</h1>
            <p>Invalid state parameter. Please try again.</p>
          </body>
        </html>
      `);
    }

    // Get stored OAuth state
    const oauthState = oauthStates.get(state as string)!;
    const clientRedirectUri = oauthState.clientRedirectUri;
    const clientState = oauthState.clientState;

    // Exchange code for tokens with Google
    const oauth2Client = await createOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(code as string);

    console.error(`OAuth callback: Got tokens from Google. Client redirect: ${clientRedirectUri}`);

    // Clean up state
    oauthStates.delete(state as string);

    // If this was initiated by an MCP client (has redirect_uri), complete the OAuth flow
    if (clientRedirectUri) {
      // Generate authorization code for the client
      const authCode = crypto.randomBytes(32).toString("hex");

      // Store the tokens with the auth code (valid for 10 minutes)
      authorizationCodes.set(authCode, {
        timestamp: Date.now(),
        tokens: {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || undefined,
          expiry_date: tokens.expiry_date || undefined
        }
      });

      // Clean up old authorization codes
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      for (const [key, value] of authorizationCodes.entries()) {
        if (value.timestamp < tenMinutesAgo) {
          authorizationCodes.delete(key);
        }
      }

      // Redirect back to client with authorization code
      const redirectUrl = new URL(clientRedirectUri);
      redirectUrl.searchParams.set("code", authCode);
      if (clientState) {
        redirectUrl.searchParams.set("state", clientState);
      }

      console.error(`OAuth callback: Redirecting to client: ${redirectUrl.toString()}`);
      return res.redirect(redirectUrl.toString());
    }

    // Manual OAuth flow - display token to user
    return res.send(`
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .success { color: #22c55e; }
            .token { background: #f3f4f6; padding: 10px; border-radius: 5px; word-break: break-all; }
            code { background: #e5e7eb; padding: 2px 5px; border-radius: 3px; }
          </style>
        </head>
        <body>
          <h1 class="success">✓ Authorization Successful!</h1>
          <p>Your Google Drive has been connected to the MCP server.</p>

          <h2>Access Token:</h2>
          <div class="token"><code>${tokens.access_token}</code></div>

          <h2>How to Use:</h2>
          <ol>
            <li>Copy the access token above</li>
            <li>Configure your MCP client with:<br/>
              <code>Authorization: Bearer ${tokens.access_token}</code>
            </li>
            <li>Connect to the MCP endpoint: <code>${getServerUrl(req)}/mcp</code></li>
          </ol>

          <p><strong>Note:</strong> This token will expire. Use the refresh token to get a new one.</p>

          <p style="margin-top: 30px; font-size: 14px; color: #6b7280;">
            You can now close this window.
          </p>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error("Callback error:", error);
    res.status(500).send(`
      <html>
        <body>
          <h1>Authorization Failed</h1>
          <p>Error: ${error.message}</p>
        </body>
      </html>
    `);
  }
}

/**
 * OAuth Token Endpoint
 * POST /oauth/token
 *
 * Exchanges authorization code or refresh token for access token
 * Accepts OUR authorization codes from the callback redirect
 */
export async function handleToken(req: Request, res: Response): Promise<any> {
  try {
    // Manually parse body if not already parsed (workaround for MCP SDK app issues)
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          try {
            // Try JSON first
            if (req.headers['content-type']?.includes('application/json')) {
              resolve(JSON.parse(data));
            } else {
              // Try URL-encoded
              const params = new URLSearchParams(data);
              resolve(Object.fromEntries(params.entries()));
            }
          } catch (e) {
            reject(new Error('Failed to parse request body'));
          }
        });
        req.on('error', reject);
      });
    }

    const { grant_type, code, refresh_token } = body;

    if (!grant_type) {
      return res.status(400).json({
        error: "invalid_request",
        error_description: "grant_type is required"
      });
    }

    if (grant_type === "authorization_code") {
      if (!code) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "code is required for authorization_code grant"
        });
      }

      // Look up our authorization code
      const authData = authorizationCodes.get(code);
      if (!authData) {
        console.error(`Token exchange failed: Invalid authorization code`);
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Authorization code is invalid or expired"
        });
      }

      // Delete the authorization code (one-time use)
      authorizationCodes.delete(code);

      const tokens = authData.tokens;
      const expiresIn = tokens.expiry_date
        ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
        : 3600;

      console.error(`Token exchange successful: Returning Google tokens to client`);

      return res.json({
        access_token: tokens.access_token,
        token_type: "Bearer",
        expires_in: expiresIn > 0 ? expiresIn : 3600,
        refresh_token: tokens.refresh_token,
        scope: SCOPES.join(" ")
      });
    } else if (grant_type === "refresh_token") {
      if (!refresh_token) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "refresh_token is required for refresh_token grant"
        });
      }

      const oauth2Client = await createOAuthClient(req);
      oauth2Client.setCredentials({ refresh_token });
      const { credentials } = await oauth2Client.refreshAccessToken();

      return res.json({
        access_token: credentials.access_token,
        token_type: "Bearer",
        expires_in: credentials.expiry_date ? Math.floor((credentials.expiry_date - Date.now()) / 1000) : 3600,
        scope: SCOPES.join(" ")
      });
    } else {
      return res.status(400).json({
        error: "unsupported_grant_type",
        error_description: `Grant type '${grant_type}' is not supported`
      });
    }
  } catch (error: any) {
    console.error("Token error:", error);
    res.status(400).json({
      error: "invalid_grant",
      error_description: error.message
    });
  }
}

/**
 * OAuth Dynamic Client Registration (RFC 7591)
 * POST /oauth/register
 *
 * MCP clients register themselves to get a client_id.
 * Since we proxy to Google OAuth, we just generate a client_id for tracking.
 */
export async function handleRegister(req: Request, res: Response): Promise<any> {
  try {
    // Manually parse body if not already parsed (workaround for MCP SDK app issues)
    let body = req.body;
    if (!body || Object.keys(body).length === 0) {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => {
          try {
            // Try JSON first
            if (req.headers['content-type']?.includes('application/json')) {
              resolve(JSON.parse(data));
            } else {
              // Try URL-encoded
              const params = new URLSearchParams(data);
              resolve(Object.fromEntries(params.entries()));
            }
          } catch (e) {
            reject(new Error('Failed to parse request body'));
          }
        });
        req.on('error', reject);
      });
    }

    const { redirect_uris, client_name, ...rest } = body || {};

    const clientId = crypto.randomUUID();

    registeredClients.set(clientId, {
      client_id: clientId,
      redirect_uris,
      client_name,
      timestamp: Date.now()
    });

    // Clean up old registrations (older than 24 hours)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, value] of registeredClients.entries()) {
      if (value.timestamp < oneDayAgo) {
        registeredClients.delete(key);
      }
    }

    console.error(`OAuth client registered: ${clientId} (${client_name || 'unnamed'})`);

    return res.status(201).json({
      client_id: clientId,
      client_name: client_name,
      redirect_uris: redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    });
  } catch (error: any) {
    console.error("Registration error:", error);
    res.status(400).json({
      error: "invalid_client_metadata",
      error_description: error.message
    });
  }
}

/**
 * OAuth Middleware - Validates Bearer tokens (REQUIRED)
 *
 * Extracts and validates Bearer token from Authorization header
 * Attaches OAuth2Client to request for downstream handlers
 * Returns 401 with WWW-Authenticate header if no token present
 */
export async function oauthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<any> {
  // Skip auth for public endpoints
  const publicPaths = [
    "/health",
    "/oauth/authorize",
    "/oauth/callback",
    "/oauth/token",
    "/oauth/register",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration"
  ];

  if (publicPaths.some(path => req.path === path)) {
    return next();
  }

  // Extract Bearer token
  const authHeader = req.headers.authorization;

  // If no authorization header, return 401 to trigger OAuth discovery
  if (!authHeader) {
    console.error("No Authorization header - returning 401 to trigger OAuth discovery");
    const serverUrl = getServerUrl(req);
    const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource`;
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    res.setHeader("Link", `<${resourceMetadataUrl}>; rel="oauth-protected-resource"`);
    return res.status(401).json({
      error: "invalid_token",
      error_description: "Bearer token required. Visit /oauth/authorize to authenticate."
    });
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    const serverUrl = getServerUrl(req);
    const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource`;
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    res.setHeader("Link", `<${resourceMetadataUrl}>; rel="oauth-protected-resource"`);
    return res.status(401).json({
      error: "invalid_token",
      error_description: "Invalid Authorization header format. Use: Bearer <token>"
    });
  }

  const token = parts[1];

  try {
    // Create OAuth client with the token
    const oauth2Client = await createOAuthClient(req);
    oauth2Client.setCredentials({ access_token: token });

    // Verify token by getting token info
    const tokenInfo = await oauth2Client.getTokenInfo(token);

    // Check if token has required scopes
    const hasRequiredScopes = SCOPES.some(scope =>
      tokenInfo.scopes?.includes(scope)
    );

    if (!hasRequiredScopes) {
      return res.status(403).json({
        error: "insufficient_scope",
        error_description: "Token does not have required Google Drive scopes"
      });
    }

    // Attach authenticated client to request
    (req as any).authClient = oauth2Client;
    (req as any).userId = tokenInfo.email || "authenticated-user";
    (req as any).authMethod = "oauth";

    console.error(`OAuth authentication successful for: ${tokenInfo.email}`);
    next();
  } catch (error: any) {
    console.error("Token validation error:", error);
    const serverUrl = getServerUrl(req);
    const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource`;
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    res.setHeader("Link", `<${resourceMetadataUrl}>; rel="oauth-protected-resource"`);
    return res.status(401).json({
      error: "invalid_token",
      error_description: "Token validation failed: " + error.message
    });
  }
}

/**
 * Get authenticated OAuth2Client from request
 */
export function getAuthFromRequest(req: Request): OAuth2Client {
  const authClient = (req as any).authClient;
  if (!authClient) {
    throw new Error("Request not authenticated");
  }
  return authClient;
}

/**
 * Setup OAuth routes
 */
export function setupOAuthRoutes(app: any): void {
  // OAuth discovery endpoints
  app.get("/.well-known/oauth-protected-resource", handleOAuthMetadata);
  app.get("/.well-known/oauth-authorization-server", handleAuthServerMetadata);
  app.get("/.well-known/openid-configuration", handleAuthServerMetadata); // OIDC fallback

  // OAuth flow endpoints (handlers parse body manually due to MCP SDK app conflicts)
  app.get("/oauth/authorize", handleAuthorize);
  app.get("/oauth/callback", handleCallback);
  app.post("/oauth/token", handleToken);
  app.post("/oauth/register", handleRegister);
}
