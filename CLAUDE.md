# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## ⚡ Recent Updates (Feb 12, 2026)

**✅ MAJOR UPDATE: Full OAuth 2.0 Implementation Complete!**

### What Changed:
- ✅ **OAuth 2.0 Authorization Server** - Users authenticate with their own Google accounts
- ✅ **Bearer Token Authentication** - Standard OAuth flow with token validation
- ✅ **Simplified Architecture** - Removed complex multi-user credential system
- ✅ **AWS Deployment Working** - Deployed at `35.174.9.35:3000`
- ✅ **All MCP Clients Supported** - TextQL, Claude Desktop, etc.

### Why OAuth is Better:
- **No pre-configuration** - Users authenticate themselves
- **Scales infinitely** - Any Google user can connect
- **More secure** - Tokens managed by OAuth flow
- **Standard MCP pattern** - Follows MCP OAuth specification

See `OAUTH_IMPLEMENTATION.md` for complete details.

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

**Two Modes:**

#### 1. Local Mode (stdio) - Pre-authenticated
For local MCP clients like Claude Desktop:
1. **Setup**: `node dist/index.js auth-user <userId>` - Opens browser OAuth flow
2. **Storage**: Saves credentials to `credentials/user-<userId>.json`
3. **Runtime**: Server loads pre-authenticated credentials
4. **MCP Client**: Connects via stdio transport (no Bearer tokens needed)

**Credential Locations**:
- `GDRIVE_USER` environment variable specifies which user
- Default: `credentials/user-default.json`
- AWS: `mcp-gdrive/users/<userId>` in Secrets Manager

#### 2. Remote Mode (HTTP) - Full OAuth 2.0
For remote MCP clients like TextQL:
1. **User visits**: `http://server:3000/oauth/authorize`
2. **Google OAuth**: Browser redirects to Google consent screen
3. **User grants access**: To their Google Drive
4. **Callback**: Server receives auth code, exchanges for access token
5. **User copies token**: From success page
6. **MCP Client**: Sends `Authorization: Bearer <token>` with each request
7. **Server validates**: Token with Google on every request

**OAuth Endpoints**:
- `GET /oauth/authorize` - Initiates OAuth flow
- `GET /oauth/callback` - Receives authorization code
- `POST /oauth/token` - Token exchange & refresh
- `GET /.well-known/oauth-protected-resource` - RFC 9728 metadata
- `GET /.well-known/oauth-authorization-server` - RFC 8414 metadata

**OAuth Keys** (required for both modes):
- Local: `gcp-oauth.keys.json` in project root
- AWS: `mcp-gdrive/oauth-keys` in Secrets Manager
- Download from Google Cloud Console (OAuth Client ID credentials)

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