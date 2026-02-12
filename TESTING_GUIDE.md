# Testing Guide - MCP Google Drive Server

## Quick Start

### Option 1: Local Mode (Claude Desktop, stdio)

The server is now configured in `.mcp.json` and will work automatically with Claude Desktop.

**Test it:**
1. Restart Claude Desktop
2. Ask: "List my Google Drive files"
3. The server should connect automatically using the `scott` user credentials

### Option 2: HTTP Mode (TextQL, Remote Clients)

**Start the server:**
```bash
node dist/src/http-server.js
```

**Expected output:**
```
Starting MCP Google Drive HTTP Server (No Auth Required)...
Environment: development
Default user: scott
Found 1 user(s): scott
✓ Loaded credentials for user: scott

Server listening on port 3000
Health check: http://localhost:3000/health
List users: http://localhost:3000/users
MCP SSE endpoint: http://localhost:3000/sse
```

**Test endpoints:**
```bash
# Health check
curl http://localhost:3000/health

# List available users
curl http://localhost:3000/users

# Test SSE connection (default user)
curl -N http://localhost:3000/sse

# Test SSE connection (specific user)
curl -N "http://localhost:3000/sse?user=scott"
```

---

## For TextQL Configuration

**TextQL config:**
```json
{
  "mcpServers": {
    "gdrive": {
      "url": "http://localhost:3000/sse",
      "transport": "sse"
    }
  }
}
```

Or with specific user:
```json
{
  "mcpServers": {
    "gdrive": {
      "url": "http://localhost:3000/sse?user=scott",
      "transport": "sse"
    }
  }
}
```

---

## Available MCP Operations

Once connected, you can:

1. **List files**: List all files in Google Drive (paginated, 10 per page)
2. **Read files**: Read file content by URI (`gdrive:///<file_id>`)
3. **Search files**: Search for files using the `search` tool

**Example interactions:**
- "Show me my Google Drive files"
- "Search for files containing 'project'"
- "Read the file gdrive:///1ABC123xyz"

---

## Troubleshooting

### stdio mode: "Credentials not found for user 'default'"

**Fix**: Ensure `.mcp.json` has the correct GDRIVE_USER environment variable:
```json
{
  "mcpServers": {
    "gdrive": {
      "env": {
        "GDRIVE_USER": "scott"
      }
    }
  }
}
```

### HTTP mode: "Session not found"

**This is fixed!** The previous implementation was broken. After the fixes:
- Sessions are now properly tracked
- Messages are routed correctly through `transport.handlePostMessage()`
- Session cleanup happens automatically on disconnect

### "No users authenticated yet"

**Solution**: Authenticate a user first:
```bash
node dist/index.js auth-user scott
```

---

## Testing the Fixes

### Verify SSE Session Management Works

1. Start the HTTP server
2. Open a new terminal and establish an SSE connection:
```bash
curl -N http://localhost:3000/sse
```

3. In the server logs, you should see:
```
New SSE connection established for user: scott
Session created: <session-id>
```

4. Stop the curl command (Ctrl+C)
5. Server logs should show:
```
SSE connection closed for user: scott, session: <session-id>
```

This confirms session tracking and cleanup are working!

---

## What Was Fixed

✅ **Bug #1**: SSE transport now properly tracks sessions and handles messages
✅ **Bug #2**: `.mcp.json` configured for Claude Desktop
✅ **Bug #3**: Removed 102 lines of dead OAuth code
⚠️ **Bug #4**: SSE deprecation noted (will migrate to Streamable HTTP later)

---

## Production Deployment

For AWS deployment, see `DEPLOYMENT_AWS.md`. The fixes apply to both local and cloud deployments.

**Key changes for cloud:**
- Session management works the same way
- Multiple concurrent connections now properly supported
- No authentication required (uses pre-configured Google credentials)
