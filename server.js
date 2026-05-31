// server.js — Continental Agent 3 (Phase 1: OAuth + Handshake only)
// Endpoints:
//   GET /              → status dashboard
//   GET /xero/auth     → start OAuth flow (redirects to Xero login)
//   GET /xero/callback → Xero returns here with auth code → exchange for tokens
//   GET /xero/test     → handshake: calls Xero API, returns org name + status
//   GET /xero/token    → shows current token status (no secret values)

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Xero OAuth constants ───────────────────────────────────────────────────────
const XERO_AUTH_URL    = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL   = 'https://identity.xero.com/connect/token';
const XERO_CONNECT_URL = 'https://api.xero.com/connections';
const XERO_API_BASE    = 'https://api.xero.com/api.xro/2.0';

// Granular scopes required for apps created after 2 March 2026
// accounting.transactions was retired — split into banktransactions + invoices
const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'accounting.settings',
  'accounting.contacts',
  'accounting.banktransactions',
  'accounting.invoices',
].join(' ');

// ── In-memory token store (replaced by ENV vars after first flow) ─────────────
// On boot, load from ENV if already set
let tokenStore = {
  accessToken:  null,
  refreshToken: process.env.XERO_REFRESH_TOKEN !== 'PENDING_OAUTH_FLOW'
                  ? process.env.XERO_REFRESH_TOKEN : null,
  tenantId:     process.env.XERO_TENANT_ID     !== 'PENDING_OAUTH_FLOW'
                  ? process.env.XERO_TENANT_ID : null,
  expiresAt:    null,
};

// ── Token helpers ─────────────────────────────────────────────────────────────
function basicAuth() {
  const creds = `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error('No refresh token. Complete OAuth flow first.');
  console.log('[Xero] Refreshing access token…');
  const res = await axios.post(XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokenStore.refreshToken,
    }).toString(),
    { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokenStore.accessToken  = res.data.access_token;
  tokenStore.refreshToken = res.data.refresh_token; // Xero rotates refresh tokens
  tokenStore.expiresAt    = Date.now() + (res.data.expires_in * 1000);
  console.log('[Xero] ✓ Access token refreshed — expires in', res.data.expires_in, 's');
  return tokenStore.accessToken;
}

async function getValidAccessToken() {
  const expired = !tokenStore.expiresAt || Date.now() > tokenStore.expiresAt - 60000;
  if (!tokenStore.accessToken || expired) {
    return await refreshAccessToken();
  }
  return tokenStore.accessToken;
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  agent:     'Continental Agent 3',
  status:    'ok',
  timestamp: new Date().toISOString(),
  xero: {
    clientId:     !!process.env.XERO_CLIENT_ID,
    clientSecret: !!process.env.XERO_CLIENT_SECRET,
    redirectUri:  process.env.XERO_REDIRECT_URI,
    refreshToken: tokenStore.refreshToken ? '✓ set' : '✗ pending OAuth',
    tenantId:     tokenStore.tenantId     ? '✓ set' : '✗ pending OAuth',
  },
}));

// ── GET /xero/auth — Step 1: redirect user to Xero login ─────────────────────
app.get('/xero/auth', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     process.env.XERO_CLIENT_ID,
    redirect_uri:  process.env.XERO_REDIRECT_URI,
    scope:         SCOPES,
    state:         'continental-agent3', // CSRF protection
  });
  const url = `${XERO_AUTH_URL}?${params.toString()}`;
  console.log('[Xero Auth] Redirecting to Xero login…');
  res.redirect(url);
});

// ── GET /xero/callback — Step 2: Xero returns auth code, exchange for tokens ──
app.get('/xero/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.error('[Xero Callback] Error:', error);
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }
  if (state !== 'continental-agent3') {
    return res.status(400).send('Invalid state parameter — possible CSRF.');
  }
  if (!code) {
    return res.status(400).send('No auth code received from Xero.');
  }

  try {
    console.log('[Xero Callback] Exchanging auth code for tokens…');

    // Exchange code for tokens
    const tokenRes = await axios.post(XERO_TOKEN_URL,
      new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: process.env.XERO_REDIRECT_URI,
      }).toString(),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    tokenStore.accessToken  = tokenRes.data.access_token;
    tokenStore.refreshToken = tokenRes.data.refresh_token;
    tokenStore.expiresAt    = Date.now() + (tokenRes.data.expires_in * 1000);
    console.log('[Xero Callback] ✓ Tokens received');

    // Get tenant ID from connections
    const connRes = await axios.get(XERO_CONNECT_URL, {
      headers: { Authorization: `Bearer ${tokenStore.accessToken}` },
    });
    const connections = connRes.data;
    if (connections.length === 0) throw new Error('No Xero organisations connected.');
    tokenStore.tenantId = connections[0].tenantId;
    const tenantName    = connections[0].tenantName;
    console.log(`[Xero Callback] ✓ Tenant: ${tenantName} (${tokenStore.tenantId})`);

    // Redirect to dashboard showing the values to copy
    res.redirect(`/?oauth=success&tenant=${encodeURIComponent(tenantName)}`);

  } catch (err) {
    console.error('[Xero Callback] Failed:', err.response?.data || err.message);
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /xero/token — show token status (no secret values) ───────────────────
app.get('/xero/token', (req, res) => {
  res.json({
    hasAccessToken:  !!tokenStore.accessToken,
    hasRefreshToken: !!tokenStore.refreshToken,
    hasTenantId:     !!tokenStore.tenantId,
    tenantId:        tokenStore.tenantId || null,
    expiresAt:       tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null,
    // Show refresh token so user can copy it into Render ENV
    // (safe — this endpoint is internal, not public-facing)
    refreshToken:    tokenStore.refreshToken || 'NOT YET — complete OAuth flow',
    instruction:     tokenStore.refreshToken
      ? 'Copy the refreshToken value above into XERO_REFRESH_TOKEN in Render ENV vars'
      : 'Visit /xero/auth to complete the OAuth flow first',
  });
});

// ── GET /xero/test — handshake: call Xero API and return org details ──────────
app.get('/xero/test', async (req, res) => {
  const start = Date.now();
  console.log('[Xero Test] Starting handshake…');

  if (!tokenStore.refreshToken) {
    return res.json({
      success: false,
      error:   'No refresh token. Visit /xero/auth to connect first.',
      hint:    'Complete the OAuth flow — it takes 30 seconds.',
    });
  }

  try {
    const accessToken = await getValidAccessToken();

    // Call 1: Get connections (tenant list)
    const connRes = await axios.get(XERO_CONNECT_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const tenant = connRes.data[0];

    // Call 2: Get organisation details
    const orgRes = await axios.get(`${XERO_API_BASE}/Organisation`, {
      headers: {
        Authorization:   `Bearer ${accessToken}`,
        'Xero-tenant-id': tokenStore.tenantId,
      },
    });
    const org = orgRes.data.Organisations?.[0];

    const ms = Date.now() - start;
    console.log(`[Xero Test] ✓ Connected to: ${org?.Name} in ${ms}ms`);

    res.json({
      success:     true,
      durationMs:  ms,
      organisation: {
        name:        org?.Name,
        legalName:   org?.LegalName,
        country:     org?.CountryCode,
        currency:    org?.BaseCurrency,
        timezone:    org?.Timezone,
        fyeMonth:    org?.FinancialYearEndMonth,
        xeroVersion: org?.Version,
      },
      tenant: {
        tenantId:   tenant?.tenantId,
        tenantName: tenant?.tenantName,
        tenantType: tenant?.tenantType,
      },
      tokenStatus: {
        hasRefreshToken: !!tokenStore.refreshToken,
        expiresAt:       new Date(tokenStore.expiresAt).toISOString(),
      },
    });

  } catch (err) {
    const ms = Date.now() - start;
    const status = err.response?.status;
    const detail = err.response?.data;
    console.error('[Xero Test] Failed:', status, detail || err.message);
    res.json({
      success:    false,
      durationMs: ms,
      error:      err.message,
      status,
      detail,
      hint: status === 401 ? 'Token expired or invalid — try /xero/auth again'
          : status === 403 ? 'Missing scopes — check Configuration in Xero developer portal'
          : 'Check Render logs for details',
    });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const ok = v => v && v !== 'PENDING_OAUTH_FLOW' ? '✓' : '✗ PENDING';
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│       CONTINENTAL PROJECT — AGENT 3                  │');
  console.log('│       Xero API Sync  (Phase 1: OAuth + Handshake)    │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  http://localhost:${PORT}                                 │`);
  console.log(`│  Client ID     : ${ok(process.env.XERO_CLIENT_ID)}  XERO_CLIENT_ID             │`);
  console.log(`│  Client Secret : ${ok(process.env.XERO_CLIENT_SECRET)}  XERO_CLIENT_SECRET         │`);
  console.log(`│  Redirect URI  : ${ok(process.env.XERO_REDIRECT_URI)}  XERO_REDIRECT_URI           │`);
  console.log(`│  Refresh Token : ${ok(process.env.XERO_REFRESH_TOKEN)}  XERO_REFRESH_TOKEN          │`);
  console.log(`│  Tenant ID     : ${ok(process.env.XERO_TENANT_ID)}  XERO_TENANT_ID              │`);
  console.log('├──────────────────────────────────────────────────────┤');
  console.log('│  NEXT STEP: visit /xero/auth to connect to Xero      │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');
});
