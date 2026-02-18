#!/usr/bin/env node

/**
 * Test OAuth Discovery Flow
 * Simulates what the MCP SDK client does (Claude, TextQL)
 */

const https = require('https');

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: opts.method || 'GET',
      headers: opts.headers || {}
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
          ok: res.statusCode >= 200 && res.statusCode < 300
        });
      });
    }).on('error', reject);
  });
}

async function testOAuthDiscovery() {
  const serverUrl = 'https://d31qbmfzvdzz4u.cloudfront.net';

  console.log('🔍 Testing OAuth Discovery Flow (MCP SDK simulation)\n');
  console.log('=' .repeat(60));

  // Step 1: Try to connect to MCP endpoint - should get 401
  console.log('\n📍 Step 1: Connecting to MCP endpoint (expect 401)');
  const mcpResponse = await fetch(`${serverUrl}/mcp`);
  console.log(`Status: ${mcpResponse.status}`);
  if (mcpResponse.status !== 401) { console.log('❌ ERROR: Expected 401'); return false; }
  console.log('✅ Got 401 - OAuth discovery triggered');

  // Step 2: Parse WWW-Authenticate header
  console.log('\n📍 Step 2: Parsing WWW-Authenticate header');
  const wwwAuth = mcpResponse.headers['www-authenticate'];
  console.log(`Header: ${wwwAuth}`);
  if (!wwwAuth) { console.log('❌ ERROR: No WWW-Authenticate header'); return false; }

  const resourceMetadataMatch = wwwAuth.match(/resource_metadata="([^"]+)"/);
  if (!resourceMetadataMatch) { console.log('❌ ERROR: No resource_metadata in header'); return false; }
  const resourceMetadataUrl = resourceMetadataMatch[1];
  console.log(`✅ resource_metadata: ${resourceMetadataUrl}`);

  // Step 3: Fetch protected resource metadata
  console.log('\n📍 Step 3: Fetching protected resource metadata (RFC 9728)');
  const prRes = await fetch(resourceMetadataUrl);
  if (!prRes.ok) { console.log(`❌ ERROR: HTTP ${prRes.status}`); return false; }
  const prMeta = JSON.parse(prRes.body);
  console.log(JSON.stringify(prMeta, null, 2));

  // Step 4: Validate authorization_servers contains ISSUER URL (not metadata URL)
  console.log('\n📍 Step 4: Validating authorization_servers is issuer URL');
  if (!prMeta.authorization_servers || prMeta.authorization_servers.length === 0) {
    console.log('❌ ERROR: No authorization_servers'); return false;
  }
  const authServerUrl = prMeta.authorization_servers[0];
  console.log(`authorization_servers[0]: ${authServerUrl}`);

  // CRITICAL CHECK: Should be base URL, not metadata URL
  if (authServerUrl.includes('/.well-known/')) {
    console.log('❌ BUG: authorization_servers contains metadata URL (not issuer URL)!');
    console.log('   MCP SDK will build wrong discovery paths like:');
    console.log(`   /.well-known/oauth-authorization-server${new URL(authServerUrl).pathname}`);
    return false;
  }
  console.log('✅ authorization_servers contains issuer URL (not metadata URL)');

  // Step 5: Discover authorization server metadata (exactly like MCP SDK does it)
  // SDK calls discoverAuthorizationServerMetadata(authServerUrl)
  // which tries /.well-known/oauth-authorization-server first, then /.well-known/openid-configuration
  console.log('\n📍 Step 5: Discovering authorization server metadata (RFC 8414)');

  const authServerBaseUrl = new URL(authServerUrl);
  const oauthMetaUrl = `${authServerBaseUrl.origin}/.well-known/oauth-authorization-server`;
  console.log(`Trying: ${oauthMetaUrl}`);

  const asRes = await fetch(oauthMetaUrl);
  console.log(`Status: ${asRes.status}`);
  if (!asRes.ok) { console.log(`❌ ERROR: HTTP ${asRes.status}`); return false; }
  const asMeta = JSON.parse(asRes.body);
  console.log(JSON.stringify(asMeta, null, 2));

  // Validate required RFC 8414 fields
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'response_types_supported'];
  for (const f of required) {
    if (!asMeta[f]) { console.log(`❌ Missing required field: ${f}`); return false; }
    console.log(`✅ ${f}: present`);
  }
  if (!asMeta.code_challenge_methods_supported?.includes('S256')) {
    console.log('❌ S256 PKCE not supported'); return false;
  }
  console.log('✅ S256 PKCE supported');
  if (!asMeta.registration_endpoint) {
    console.log('❌ registration_endpoint missing (required for dynamic client registration)'); return false;
  }
  console.log('✅ registration_endpoint present');

  // Step 6: Test OIDC discovery (fallback the SDK also tries)
  console.log('\n📍 Step 6: Testing OIDC discovery (SDK fallback)');
  const oidcUrl = `${authServerBaseUrl.origin}/.well-known/openid-configuration`;
  console.log(`Trying: ${oidcUrl}`);

  const oidcRes = await fetch(oidcUrl);
  console.log(`Status: ${oidcRes.status}`);
  if (!oidcRes.ok) { console.log('❌ OIDC discovery failed'); return false; }
  const oidcMeta = JSON.parse(oidcRes.body);

  // Validate OIDC required fields (from OpenIdProviderDiscoveryMetadataSchema)
  const oidcRequired = ['issuer', 'authorization_endpoint', 'token_endpoint',
    'jwks_uri', 'response_types_supported', 'subject_types_supported',
    'id_token_signing_alg_values_supported'];
  for (const f of oidcRequired) {
    if (!oidcMeta[f]) { console.log(`❌ OIDC missing required field: ${f}`); return false; }
    console.log(`✅ OIDC ${f}: present`);
  }

  // Step 7: Test userinfo endpoint
  console.log('\n📍 Step 7: Testing userinfo endpoint');
  const userInfoUrl = `${authServerBaseUrl.origin}/oauth/userinfo`;
  const uiRes = await fetch(userInfoUrl);
  console.log(`Status: ${uiRes.status} (expect 401 without token)`);
  if (uiRes.status !== 401) {
    console.log('❌ Userinfo should require auth'); return false;
  }
  console.log('✅ Userinfo correctly requires authentication');

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('🎉 OAuth + OIDC Discovery Flow: SUCCESS');
  console.log('=' .repeat(60));
  console.log('\nKey fixes verified:');
  console.log('✅ authorization_servers contains issuer URL (not metadata URL)');
  console.log('✅ OAuth AS metadata (RFC 8414) is discoverable by MCP SDK');
  console.log('✅ OIDC configuration has all required fields (jwks_uri, subject_types, alg_values)');
  console.log('✅ PKCE (S256) supported');
  console.log('✅ Dynamic client registration endpoint present');
  console.log('✅ Userinfo endpoint requires authentication');

  return true;
}

testOAuthDiscovery().then(ok => {
  if (!ok) {
    console.error('\n❌ Test FAILED');
    process.exit(1);
  }
}).catch(err => {
  console.error('\n❌ Test failed with error:', err.message);
  process.exit(1);
});
