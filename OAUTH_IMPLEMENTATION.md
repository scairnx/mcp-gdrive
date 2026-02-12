# OAuth 2.0 Implementation Complete

## Overview

The MCP Google Drive Server now implements the **full OAuth 2.0 Resource Server specification** as required by the MCP HTTP transport specification.

## Architecture

### OAuth Flow

```
┌─────────────┐                ┌──────────────────┐
│   TextQL    │                │  MCP GDrive      │
│  (Client)   │                │  (Resource       │
│             │                │   Server)        │
└──────┬──────┘                └────────┬─────────┘
       │                                │
       │  1. Connect without token      │
       │───────────────────────────────>│
       │                                │
       │  2. 401 + WWW-Authenticate     │
       │<───────────────────────────────│
       │     + resource_metadata URL    │
       │                                │
       │  3. GET resource metadata      │
       │───────────────────────────────>│
       │                                │
       │  4. Resource metadata JSON     │
       │<───────────────────────────────│
       │     (authorization_servers:    │
       │      accounts.google.com)      │
       │                                │
       │  5. Redirect user to Google    │
       │    for authentication          │
       │                                │
       v                                │
┌──────────────┐                        │
│   Google     │                        │
│   OAuth      │                        │
│   (AuthZ     │                        │
│    Server)   │                        │
└──────┬───────┘                        │
       │                                │
       │  6. User authenticates         │
       │  7. Google returns token       │
       │                                │
       └───────────────────────────────>│
                                        │
       ┌───────────────────────────────>│
       │  8. MCP requests with          │
       │     Authorization: Bearer      │
       │                                │
       │  9. Validate token & respond   │
       │<───────────────────────────────│
```

### Key Changes

**Before (Pre-authenticated credentials):**
- Server stored credentials for each user (scott, alice, etc.)
- Users selected which account via `?user=scott`
- No authentication from MCP client
- Users needed to be pre-configured in AWS Secrets Manager

**After (OAuth 2.0 Resource Server):**
- Server requires OAuth Bearer tokens from clients
- Each TextQL user authenticates with their own Google account
- No pre-configuration needed
- Tokens are validated against Google
- Users access their own Google Drive

## Implementation Details

### RFC Compliance

Implements the following RFCs as required by MCP specification:

- **RFC 9728** - OAuth 2.0 Protected Resource Metadata
- **OAuth 2.1** - Authorization framework (draft-ietf-oauth-v2-1-13)
- **RFC 6750** - Bearer Token Usage

### Endpoints

#### 1. Protected Resource Metadata
```
GET /.well-known/oauth-protected-resource
```

Returns:
```json
{
  "resource": "http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com",
  "authorization_servers": [
    "https://accounts.google.com"
  ],
  "bearer_methods_supported": ["header"],
  "resource_signing_alg_values_supported": ["RS256"],
  "scopes_supported": [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly"
  ]
}
```

#### 2. MCP Endpoint (OAuth Protected)
```
GET /sse
Authorization: Bearer <google-oauth-token>
```

**Without token:**
```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="...", resource_metadata="...", scope="..."

{
  "error": "unauthorized",
  "error_description": "Access token required. Please authenticate with Google OAuth 2.0.",
  "authorization_server": "https://accounts.google.com",
  "resource_metadata": "http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com/.well-known/oauth-protected-resource"
}
```

**With valid token:**
- Establishes SSE connection
- Uses token to access Google Drive on behalf of the authenticated user

### Security

**Token Validation:**
- Tokens are verified with Google
- Only tokens from Google's Authorization Server are accepted
- Audience validation ensures tokens are for this resource
- Invalid/expired tokens receive 401 responses

**Scopes Required:**
- `https://www.googleapis.com/auth/drive.readonly` - Read Google Drive files
- `https://www.googleapis.com/auth/drive.metadata.readonly` - Read file metadata

## TextQL Integration

### Configuration

**MCP Server URL:**
```
http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com/sse
```

**Expected Flow:**
1. TextQL connects to the MCP endpoint
2. Receives 401 with OAuth metadata
3. Discovers Google as Authorization Server
4. Redirects user to Google for authentication
5. User grants permissions to TextQL
6. TextQL receives Bearer token
7. TextQL connects with `Authorization: Bearer <token>`
8. User can now query their Google Drive through TextQL

### Benefits

✅ **No Pre-configuration** - Users don't need to be added to AWS Secrets Manager
✅ **User-specific Access** - Each TextQL user accesses their own Google Drive
✅ **Standard OAuth** - Follows industry-standard authentication
✅ **Secure** - Tokens are validated, not stored
✅ **Scalable** - No limit on number of users

## Testing

### Test OAuth Discovery
```bash
curl http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com/.well-known/oauth-protected-resource | jq .
```

### Test 401 Response
```bash
curl -i http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com/sse
```

Should return:
- Status: `401 Unauthorized`
- Header: `WWW-Authenticate: Bearer ...`
- Body: JSON with error details

### Health Check
```bash
curl http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com/health | jq .
```

## Production Deployment

**Current Status:** ✅ Deployed to AWS ECS Fargate

- **ALB URL:** `http://mcp-gdrive-alb-1539902201.us-east-1.elb.amazonaws.com`
- **Region:** `us-east-1`
- **Cluster:** `mcp-gdrive-cluster`
- **Service:** `mcp-gdrive-service`
- **Task Definition:** `mcp-gdrive-task:2`

**Environment Variables:**
- `SERVER_URL` - Set to ALB URL for OAuth metadata
- `PORT` - `3000`
- `NODE_ENV` - `production`
- `AWS_REGION` - `us-east-1`

## Migration Notes

### Old Pre-authenticated Credentials

The following are **no longer used**:
- ❌ `credentials/user-*.json` files
- ❌ AWS Secrets Manager per-user secrets (`mcp-gdrive/users/*`)
- ❌ `?user=scott` query parameter
- ❌ `X-GDrive-User` header

### What to Keep

These are still relevant:
- ✅ `gcp-oauth.keys.json` - OAuth client configuration
- ✅ AWS Secrets Manager `mcp-gdrive/oauth-keys` - OAuth keys in AWS

## Next Steps

1. **Configure TextQL** - Add the MCP server URL to TextQL
2. **Test Authentication** - Try connecting from TextQL
3. **User Onboarding** - Each user authenticates through TextQL with their Google account
4. **Monitor** - Check CloudWatch logs for any issues

## Troubleshooting

### "Failed to discover OAuth endpoints"

**Cause:** Old cached MCP server configuration
**Solution:** TextQL should now successfully discover OAuth metadata

### "invalid_token" Error

**Cause:** Token validation failed
**Solution:** Ensure user authenticated with Google OAuth and token is valid

### Connection Timeout

**Cause:** Network/firewall issues
**Solution:** Verify ALB security group allows port 80 from TextQL IPs

## References

- [MCP Authorization Specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [RFC 9728 - OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [OAuth 2.1 Draft](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
- [RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
