# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚡ Recent Updates (Feb 12, 2026)

**✅ MAJOR FIX: Hybrid Authentication - Works with ALL MCP Clients!**

### What Changed:
- ✅ **Hybrid Authentication** - Supports BOTH OAuth 2.0 AND pre-authenticated credentials
- ✅ **Claude Desktop Fixed** - Now works with stdio transport + pre-auth
- ✅ **TextQL Fixed** - Now works with HTTP transport + OAuth OR pre-auth
- ✅ **No Configuration Required** - Server auto-detects authentication method
- ✅ **AWS Deployment Compatible** - Works with both auth methods in cloud

### Authentication Modes:
**Pre-Authenticated** (Simpler - recommended for local use):
- One-time setup: `node dist/index.js auth-user scott`
- MCP clients connect without Bearer tokens
- Perfect for Claude Desktop, VS Code

**OAuth 2.0** (Flexible - recommended for cloud/remote):
- Users authenticate via browser flow
- Get Bearer token, use `Authorization: Bearer <token>`
- Perfect for TextQL, cloud deployments, multi-user scenarios

**Both modes work simultaneously!** The server automatically uses whichever authentication is provided.

See below for complete setup instructions.

---

## 🚨 Critical AWS Deployment Note

**Docker Platform Issue:**
When deploying to AWS from Apple Silicon (M1/M2/M3 Macs), you MUST specify the platform:

```bash
docker build --platform linux/amd64 -t image-name .
```

**Why:** Docker on Apple Silicon builds ARM64 images by default, but AWS Fargate requires AMD64/x86_64. Without `--platform linux/amd64`, deployment will fail with:
```
CannotPullContainerError: image Manifest does not contain descriptor matching platform 'linux/amd64'
```

**Fixed in:** `scripts/deploy-aws.sh` (automatically builds for correct platform)

---

## Project Overview

This is an MCP (Model Context Protocol) server for Google Drive integration. It enables Claude and other MCP clients to interact with Google Drive through a standardized interface, providing file search, listing, and read capabilities.

**Source**: Based on Anthropic's archived reference implementation from `modelcontextprotocol/servers-archived`

## Architecture

### Core Components

**MCP Server** (supports both stdio and HTTP transports):
- Built using `@modelcontextprotocol/sdk` (v1.0.1)
- **Local mode** (`index.ts`): stdio transport for local MCP clients (Claude Desktop, VS Code) - uses pre-authenticated credentials
- **Remote mode** (`src/http-server.ts`): SSE over HTTP with **full OAuth 2.0 server** for remote MCP clients (TextQL, cloud deployments)
- Implements Google Drive API v3 via `googleapis` library
- **OAuth 2.0 Authorization Server** (`src/oauth.ts`): Complete implementation with authorization, token exchange, and Bearer token validation
- OAuth2 authentication with read-only scopes (`drive.readonly`, `drive.metadata.readonly`)
- Shared handlers (`src/handlers.ts`) for MCP operations

**Request Handlers**:
1. **ListResourcesRequestSchema**: Paginated listing of Google Drive files (10 per page)
2. **ReadResourceRequestSchema**: File content retrieval with automatic format conversion
3. **ListToolsRequestSchema**: Exposes the `search` tool
4. **CallToolRequestSchema**: Executes the `search` tool with query escaping

**Resource URIs**: Files are exposed as `gdrive:///<file_id>`

**Automatic Format Conversion**:
- Google Docs → Markdown (`text/markdown`)
- Google Sheets → CSV (`text/csv`)
- Google Presentations → Plain text (`text/plain`)
- Google Drawings → PNG (`image/png`)
- Text files and JSON → UTF-8 text
- Binary files → Base64-encoded blob

### Authentication Flow

**🎯 Hybrid Authentication - Choose What Works Best:**

The HTTP server (`src/http-server.ts`) supports BOTH authentication methods simultaneously:

#### Method 1: Pre-Authenticated Credentials (Simpler ✅ Recommended for local)

**Setup once, works forever:**
```bash
# Authenticate user "scott"
node dist/index.js auth-user scott
```

**How it works:**
1. Opens browser OAuth flow (one time only)
2. Saves credentials to `credentials/user-scott.json`
3. HTTP server loads credentials at startup
4. **No Bearer token needed!** - MCP clients connect directly

**Start HTTP server with pre-auth:**
```bash
GDRIVE_USER=scott node dist/src/http-server.js
# OR set in environment/Docker
```

**Perfect for:**
- Claude Desktop (via HTTP mode)
- Local development
- Single-user scenarios
- Simpler configuration

#### Method 2: OAuth 2.0 Bearer Tokens (Flexible ✅ Recommended for cloud)

**User-driven authentication:**
1. User visits: `https://your-server/oauth/authorize`
2. Google OAuth consent screen
3. User grants Google Drive access
4. Copy access token from success page
5. MCP client uses: `Authorization: Bearer <token>`

**OAuth Endpoints:**
- `GET /oauth/authorize` - Start OAuth flow
- `GET /oauth/callback` - OAuth callback handler
- `POST /oauth/token` - Token exchange & refresh
- `GET /.well-known/oauth-protected-resource` - RFC 9728 metadata
- `GET /.well-known/oauth-authorization-server` - RFC 8414 metadata

**Perfect for:**
- TextQL and remote MCP clients
- Multi-user scenarios
- Cloud deployments
- Users authenticating with their own Google accounts

#### How Hybrid Mode Works

The server checks authentication in this order:
1. **Bearer token** in `Authorization` header → Use OAuth
2. **Pre-auth credentials** from `GDRIVE_USER` env var → Use pre-auth
3. **Pre-auth credentials** from `GDRIVE_CREDENTIALS` env var → Use pre-auth
4. **No auth** → Return error

This means:
- ✅ TextQL can use OAuth (with Bearer token)
- ✅ Claude Desktop can use pre-auth (no token needed)
- ✅ Both work with the same server instance!

#### Stdio Mode (Local Only - index.ts)

For Claude Desktop stdio transport:
```bash
# Standard run (uses GDRIVE_USER environment variable)
GDRIVE_USER=scott node dist/index.js
```

Stdio mode ONLY supports pre-authenticated credentials (no OAuth).

#### OAuth Keys (Required)

Download OAuth Client ID credentials from Google Cloud Console:
- Local: Save to `gcp-oauth.keys.json` in project root
- AWS: Store in `mcp-gdrive/oauth-keys` Secrets Manager
- Used for BOTH pre-auth setup AND OAuth flow

## Development Commands

### Build
```bash
npm run build        # Compile TypeScript and make executable
npm run watch        # Watch mode for development
```

### Authentication
```bash
# First-time setup: authenticate and save credentials
node dist/index.js auth

# Or with custom paths
GDRIVE_OAUTH_PATH=/path/to/oauth.json GDRIVE_CREDENTIALS_PATH=/path/to/creds.json node dist/index.js auth
```

### Run Server

**Local stdio mode** (for Claude Desktop, VS Code):
```bash
# Standard run (requires prior authentication)
node dist/index.js

# With custom credential path
GDRIVE_CREDENTIALS_PATH=/path/to/creds.json node dist/index.js
```

**HTTP mode** (for remote clients, cloud deployment):
```bash
# Start HTTP server on port 3000
node dist/src/http-server.js

# With custom port
PORT=8080 node dist/src/http-server.js

# With AWS Secrets Manager (for cloud deployment)
AWS_REGION=us-east-1 \
GDRIVE_CREDENTIALS=<from-secrets-manager> \
GDRIVE_OAUTH=<from-secrets-manager> \
node dist/src/http-server.js
```

### NPX Usage
```bash
npx -y @modelcontextprotocol/server-gdrive
```

## Google Cloud Setup Requirements

Before using this server, complete these steps:

1. Create a Google Cloud project
2. Enable Google Drive API
3. Configure OAuth consent screen (internal mode is sufficient for testing)
4. Add OAuth scope: `https://www.googleapis.com/auth/drive.readonly`
5. Create OAuth Client ID (Desktop App type)
6. Download credentials as `gcp-oauth.keys.json`

## Integration with MCP Clients

### Claude Desktop / VS Code

**NPX Configuration**:
```json
{
  "gdrive": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-gdrive"],
    "env": {
      "GDRIVE_CREDENTIALS_PATH": "/absolute/path/to/.gdrive-server-credentials.json"
    }
  }
}
```

**Docker Configuration**:
```json
{
  "gdrive": {
    "command": "docker",
    "args": [
      "run", "-i", "--rm",
      "-v", "mcp-gdrive:/gdrive-server",
      "-e", "GDRIVE_CREDENTIALS_PATH=/gdrive-server/credentials.json",
      "mcp/gdrive"
    ]
  }
}
```

### TextQL Integration (Remote HTTP with OAuth)

For remote MCP clients like TextQL:

**Step 1: Get Access Token**
```bash
# Visit authorization URL (replace with your server IP/domain)
open http://35.174.9.35:3000/oauth/authorize

# Complete Google OAuth consent screen
# Copy the access token from the success page
```

**Step 2: Configure TextQL**
```json
{
  "mcpServers": {
    "gdrive": {
      "url": "http://35.174.9.35:3000/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer ya29.a0AfB_by..."
      }
    }
  }
}
```

**Current AWS Deployment**:
- **Server**: `http://35.174.9.35:3000`
- **OAuth**: `http://35.174.9.35:3000/oauth/authorize`
- **Authentication**: OAuth 2.0 Bearer tokens required
- **Public IP may change**: Check ECS task for current IP

See [OAUTH_IMPLEMENTATION.md](./OAUTH_IMPLEMENTATION.md) and [DEPLOYMENT_AWS.md](./DEPLOYMENT_AWS.md) for details.

## Security Considerations

**NEVER commit these files**:
- `gcp-oauth.keys.json` (OAuth client credentials)
- `.gdrive-server-credentials.json` (User authentication tokens)

These are already in `.gitignore` but verify before committing.

**Scope**: Server uses read-only access (`drive.readonly`) - no write/delete capabilities.

## Tools Exposed

**search**:
- Input: `query` (string)
- Output: List of matching files with names and MIME types
- Query format: Uses Google Drive's `fullText contains` syntax with proper escaping

## Resource Access

Files are accessible via `gdrive:///<file_id>` URIs. The server:
- Automatically detects file MIME type
- Exports Google Workspace files to portable formats
- Returns text files as UTF-8 strings
- Returns binary files as base64-encoded blobs

## Troubleshooting

**"Credentials not found" error**:
- Run `node dist/index.js auth` first
- Verify `GDRIVE_CREDENTIALS_PATH` points to valid credentials file

**Authentication failures**:
- Verify OAuth client is correctly configured in Google Cloud Console
- Check that `gcp-oauth.keys.json` contains valid client credentials
- Ensure the OAuth scope `drive.readonly` is added to the consent screen

**Build errors**:
- Run `npm install` to ensure all dependencies are present
- Check that TypeScript version is compatible (v5.6.2+)

## Cloud Deployment

This server can be deployed to AWS for remote access by MCP clients:

### Deployment Options

**AWS ECS Fargate** (Recommended for production):
- Serverless container platform
- Automatic scaling and high availability
- Integrated with AWS Secrets Manager for credential management
- See [DEPLOYMENT_AWS.md](./DEPLOYMENT_AWS.md) for complete guide

### Quick Deploy to AWS

```bash
# Prerequisites: AWS CLI configured, Docker installed
# See DEPLOYMENT_AWS.md for detailed setup

# Deploy to AWS ECS
./scripts/deploy-aws.sh
```

### Architecture for Cloud Deployment

- **Transport**: SSE over HTTP (stateless, RESTful)
- **Authentication**: AWS Secrets Manager stores Google OAuth credentials
- **Container**: Docker multi-stage build with security hardening
- **Platform**: ECS Fargate with CloudWatch logging
- **Networking**: Public IP with security group (can be enhanced with ALB/HTTPS)

### Environment Variables (Cloud)

- `PORT`: HTTP server port (default: 3000)
- `NODE_ENV`: Environment (production/development)
- `AWS_REGION`: AWS region for Secrets Manager
- `GDRIVE_CREDENTIALS`: Google Drive credentials (from Secrets Manager)
- `GDRIVE_OAUTH`: OAuth keys (from Secrets Manager)