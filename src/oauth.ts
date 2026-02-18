/**
 * OAuth 2.0 Authorization Server Implementation
 * Enables users to authenticate with their own Google accounts
 * Implements MCP OAuth specification + Google OAuth 2.0
 */

import { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";
import { loadOAuthKeys } from "./auth.js";
import crypto from "crypto";

// Scopes we advertise to MCP clients (resource access scopes)
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly"
];

// Additional OIDC scopes we always request from Google so we can provide id_token and userinfo
const OIDC_SCOPES = ["openid", "email", "profile"];

// All scopes requested from Google (OIDC + resource)
const GOOGLE_SCOPES = [...SCOPES, ...OIDC_SCOPES];

// In-memory storage for OAuth state and tokens
// In production, use Redis or a database
const oauthStates = new Map<string, {
  timestamp: number;
  clientId?: string;
  clientRedirectUri?: string;
  clientState?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}>();
const authorizationCodes = new Map<string, {
  timestamp: number;
  tokens: {
    access_token: string;
    refresh_token?: string;
    expiry_date?: number;
    id_token?: string;
  };
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri?: string;
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
 * Validate PKCE code_verifier against stored code_challenge
 */
function validatePkce(codeVerifier: string, codeChallenge: string, codeChallengeMethod: string): boolean {
  if (codeChallengeMethod === 'S256') {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest();
    const computed = hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return computed === codeChallenge;
  } else if (codeChallengeMethod === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

/**
 * OAuth Protected Resource Metadata (RFC 9728)
 * /.well-known/oauth-protected-resource
 *
 * IMPORTANT: authorization_servers must contain the ISSUER URL (base URL),
 * NOT the metadata URL. The MCP SDK derives the metadata URL from the issuer.
 */
export function handleOAuthMetadata(req: Request, res: Response): void {
  const serverUrl = getServerUrl(req);

  // No-cache so CloudFront/proxies don't serve stale metadata
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json({
    resource: serverUrl,
    // CRITICAL FIX: Use issuer URL (serverUrl), not the metadata URL
    // The MCP SDK calls discoverAuthorizationServerMetadata(authorization_servers[0])
    // and builds /.well-known/oauth-authorization-server from this base URL
    authorization_servers: [serverUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: SCOPES
  });
}

/**
 * OAuth Authorization Server Metadata (RFC 8414)
 * /.well-known/oauth-authorization-server
 *
 * Acts as OAuth authorization server proxy for Google Drive.
 * MCP clients (like Claude, TextQL) can complete the full OAuth dance through our server.
 */
export async function handleAuthServerMetadata(req: Request, res: Response): Promise<void> {
  const serverUrl = getServerUrl(req);

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json({
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/oauth/authorize`,
    token_endpoint: `${serverUrl}/oauth/token`,
    userinfo_endpoint: `${serverUrl}/oauth/userinfo`,
    registration_endpoint: `${serverUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: SCOPES
  });
}

/**
 * OpenID Connect Discovery (OIDC Discovery 1.0)
 * /.well-known/openid-configuration
 *
 * Full OIDC discovery document with required fields.
 * Required fields per MCP SDK's OpenIdProviderDiscoveryMetadataSchema:
 * - jwks_uri (REQUIRED)
 * - subject_types_supported (REQUIRED)
 * - id_token_signing_alg_values_supported (REQUIRED)
 *
 * We proxy Google's OIDC and use Google's JWKS endpoint for token validation.
 */
export async function handleOidcConfiguration(req: Request, res: Response): Promise<void> {
  const serverUrl = getServerUrl(req);

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json({
    issuer: serverUrl,
    authorization_endpoint: `${serverUrl}/oauth/authorize`,
    token_endpoint: `${serverUrl}/oauth/token`,
    userinfo_endpoint: `${serverUrl}/oauth/userinfo`,
    // Google's JWKS - used to validate id_tokens we proxy from Google
    jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
    registration_endpoint: `${serverUrl}/oauth/register`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: [...SCOPES, "openid", "email", "profile"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "email_verified", "name", "picture"]
  });
}

/**
 * OIDC Userinfo Endpoint
 * GET /oauth/userinfo
 *
 * Proxies to Google's userinfo endpoint using the Bearer token.
 * Returns user identity claims.
 */
export async function handleUserInfo(req: Request, res: Response): Promise<any> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="mcp-gdrive"');
    return res.status(401).json({ error: 'invalid_token', error_description: 'Bearer token required' });
  }

  const token = authHeader.slice(7);

  try {
    // Proxy to Google's userinfo endpoint
    const googleResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!googleResponse.ok) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp-gdrive", error="invalid_token"');
      return res.status(401).json({ error: 'invalid_token', error_description: 'Token invalid or expired' });
    }

    const userInfo = await googleResponse.json();
    return res.json(userInfo);
  } catch (error: any) {
    console.error("Userinfo error:", error);
    return res.status(500).json({ error: 'server_error', error_description: error.message });
  }
}

/**
 * OAuth Authorization Endpoint
 * GET /oauth/authorize
 *
 * Accepts authorization request from MCP client (e.g., Claude, TextQL)
 * Redirects user to Google's OAuth consent screen
 * Stores client's redirect_uri and PKCE challenge to complete the flow later
 */
export async function handleAuthorize(req: Request, res: Response): Promise<any> {
  try {
    const clientRedirectUri = req.query.redirect_uri as string;
    const clientState = req.query.state as string;
    const responseType = req.query.response_type as string;
    const codeChallenge = req.query.code_challenge as string;
    const codeChallengeMethod = (req.query.code_challenge_method as string) || 'plain';

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
      clientRedirectUri: clientRedirectUri,
      clientState: clientState,
      codeChallenge: codeChallenge,
      codeChallengeMethod: codeChallengeMethod
    });

    // Clean up old states (older than 10 minutes)
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of oauthStates.entries()) {
      if (value.timestamp < tenMinutesAgo) {
        oauthStates.delete(key);
      }
    }

    // Generate authorization URL to redirect to Google
    // Include OIDC scopes so Google returns id_token
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: GOOGLE_SCOPES,
      state: state,
      prompt: "consent" // Force consent screen to get refresh token
    });

    console.error(`OAuth authorize: redirecting to Google (client redirect: ${clientRedirectUri}, PKCE: ${!!codeChallenge})`);
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
    const codeChallenge = oauthState.codeChallenge;
    const codeChallengeMethod = oauthState.codeChallengeMethod;

    // Exchange code for tokens with Google
    const oauth2Client = await createOAuthClient(req);
    const { tokens } = await oauth2Client.getToken(code as string);

    console.error(`OAuth callback: Got tokens from Google (has id_token: ${!!tokens.id_token}, client redirect: ${clientRedirectUri})`);

    // Clean up state
    oauthStates.delete(state as string);

    // If this was initiated by an MCP client (has redirect_uri), complete the OAuth flow
    if (clientRedirectUri) {
      // Generate authorization code for the client
      const authCode = crypto.randomBytes(32).toString("hex");

      // Store the tokens with the auth code (valid for 10 minutes)
      // Also store PKCE challenge to validate at token endpoint
      authorizationCodes.set(authCode, {
        timestamp: Date.now(),
        tokens: {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || undefined,
          expiry_date: tokens.expiry_date || undefined,
          id_token: tokens.id_token || undefined
        },
        codeChallenge: codeChallenge,
        codeChallengeMethod: codeChallengeMethod,
        redirectUri: clientRedirectUri
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
 * Validates PKCE code_verifier if code_challenge was provided
 * Passes through Google's id_token for OIDC support
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

    const { grant_type, code, refresh_token, code_verifier } = body;

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

      // Validate PKCE code_verifier if a code_challenge was stored
      if (authData.codeChallenge) {
        if (!code_verifier) {
          return res.status(400).json({
            error: "invalid_grant",
            error_description: "code_verifier is required (PKCE)"
          });
        }
        const method = authData.codeChallengeMethod || 'S256';
        if (!validatePkce(code_verifier, authData.codeChallenge, method)) {
          console.error(`Token exchange failed: PKCE code_verifier mismatch`);
          return res.status(400).json({
            error: "invalid_grant",
            error_description: "code_verifier does not match code_challenge"
          });
        }
        console.error(`Token exchange: PKCE validation passed`);
      }

      // Delete the authorization code (one-time use)
      authorizationCodes.delete(code);

      const tokens = authData.tokens;
      const expiresIn = tokens.expiry_date
        ? Math.floor((tokens.expiry_date - Date.now()) / 1000)
        : 3600;

      console.error(`Token exchange successful: Returning Google tokens to client`);

      const tokenResponse: any = {
        access_token: tokens.access_token,
        token_type: "Bearer",
        expires_in: expiresIn > 0 ? expiresIn : 3600,
        refresh_token: tokens.refresh_token,
        scope: SCOPES.join(" ")
      };

      // Include id_token if available (OIDC support)
      if (tokens.id_token) {
        tokenResponse.id_token = tokens.id_token;
      }

      return res.json(tokenResponse);
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

      const refreshResponse: any = {
        access_token: credentials.access_token,
        token_type: "Bearer",
        expires_in: credentials.expiry_date ? Math.floor((credentials.expiry_date - Date.now()) / 1000) : 3600,
        scope: SCOPES.join(" ")
      };

      // Include id_token if returned by Google on refresh
      if (credentials.id_token) {
        refreshResponse.id_token = credentials.id_token;
      }

      return res.json(refreshResponse);
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
    "/oauth/userinfo",
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
    const scopesParam = SCOPES.join(" ");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopesParam}"`);
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
    const scopesParam = SCOPES.join(" ");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopesParam}"`);
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
    (req as any).accessToken = token;
    (req as any).userId = tokenInfo.email || "authenticated-user";
    (req as any).authMethod = "oauth";

    console.error(`OAuth authentication successful for: ${tokenInfo.email}`);
    next();
  } catch (error: any) {
    console.error("Token validation error:", error);
    const serverUrl = getServerUrl(req);
    const resourceMetadataUrl = `${serverUrl}/.well-known/oauth-protected-resource`;
    const scopesParam = SCOPES.join(" ");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", scope="${scopesParam}"`);
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
  // Path-specific metadata for mcp-go SDK resource ID-based discovery (RFC 9728)
  app.get("/.well-known/oauth-protected-resource/mcp", handleOAuthMetadata);
  // Workaround for buggy MCP clients that double-nest the well-known path
  app.get("/.well-known/oauth-protected-resource/.well-known/oauth-protected-resource", handleOAuthMetadata);

  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", handleAuthServerMetadata);

  // OpenID Connect Discovery (OIDC Discovery 1.0)
  // Required by MCP SDK as fallback when OAuth AS metadata fails
  // Also handles OIDC-specific paths the SDK tries
  app.get("/.well-known/openid-configuration", handleOidcConfiguration);
  app.get("/.well-known/openid-configuration/mcp", handleOidcConfiguration);

  // OAuth flow endpoints (handlers parse body manually due to MCP SDK app conflicts)
  app.get("/oauth/authorize", handleAuthorize);
  app.get("/oauth/callback", handleCallback);
  app.post("/oauth/token", handleToken);
  app.post("/oauth/register", handleRegister);

  // OIDC Userinfo endpoint
  app.get("/oauth/userinfo", handleUserInfo);
  app.post("/oauth/userinfo", handleUserInfo); // Some clients use POST
}
