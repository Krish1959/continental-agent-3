// server.js — Continental Agent 3 (Phase 2: OAuth + Handshake + Xero Sync)
require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const cors    = require('cors');

const { getReadyRows, markSynced, markFailed } = require('./ledger');
const { createSpendMoney }                     = require('./xero');

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

const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'accounting.settings',
  'accounting.contacts',
  'accounting.banktransactions',
  'accounting.invoices',
].join(' ');

// ── Token store ────────────────────────────────────────────────────────────────
let tokenStore = {
  accessToken:  null,
  refreshToken: process.env.XERO_REFRESH_TOKEN !== 'PENDING_OAUTH_FLOW'
                  ? process.env.XERO_REFRESH_TOKEN : null,
  tenantId:     process.env.XERO_TENANT_ID !== 'PENDING_OAUTH_FLOW'
                  ? process.env.XERO_TENANT_ID : null,
  expiresAt:    null,
};

// On boot: try to load a newer persisted token from Google Sheets
// (handles token rotation after server restarts)
setTimeout(async () => {
  try {
    const persisted = await loadPersistedToken();
    if (persisted && persisted !== tokenStore.refreshToken) {
      console.log('[Boot] Using newer refresh token from Google Sheets (overrides ENV)');
      tokenStore.refreshToken = persisted;
    } else if (persisted) {
      console.log('[Boot] Persisted token matches ENV token — no change needed');
    }
  } catch(e) {
    console.log('[Boot] Could not load persisted token:', e.message);
  }
}, 3000); // delay 3s to let auth module initialise

function basicAuth() {
  return 'Basic ' + Buffer.from(
    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
  ).toString('base64');
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error('No refresh token. Complete OAuth flow first at /xero/auth');
  console.log('[Xero] Refreshing access token…');
  console.log('[Xero] Using refresh token:', tokenStore.refreshToken.slice(0,20) + '…');
  let res;
  try {
    res = await axios.post(XERO_TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenStore.refreshToken }).toString(),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (tokenErr) {
    console.error('[Xero] ✗ Token refresh FAILED:');
    console.error('[Xero]   Status  :', tokenErr.response?.status);
    console.error('[Xero]   Body    :', JSON.stringify(tokenErr.response?.data));
    console.error('[Xero]   HINT    : Refresh token may be stale. Visit /xero/auth to reconnect.');
    throw tokenErr;
  }
  tokenStore.accessToken  = res.data.access_token;
  tokenStore.refreshToken = res.data.refresh_token; // Xero rotates on every use
  tokenStore.expiresAt    = Date.now() + (res.data.expires_in * 1000);
  console.log('[Xero] ✓ Token refreshed. Saving new refresh token…');
  console.log('[Xero] ══ NEW REFRESH TOKEN — COPY TO RENDER ENV ══');
  console.log('[Xero]   XERO_REFRESH_TOKEN=' + tokenStore.refreshToken);
  console.log('[Xero] ════════════════════════════════════════════');
  // Save new token to persistent store
  await saveRefreshToken(tokenStore.refreshToken).catch(e =>
    console.warn('[Xero] Could not save token to sheet:', e.message)
  );
  return tokenStore.accessToken;
}

// ── Persist refresh token to Google Sheets ────────────────────────────────────
// Saves latest token to Bills sheet "Config" tab so it survives server restarts
async function saveRefreshToken(token) {
  const { google } = require('googleapis');
  const { getAuth } = require('./auth');
  const auth   = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  const { getSheetId } = require('./ledger');
  // We store in a named range on the Bills sheet — simple cell A1 on a Config sheet
  // If it fails (sheet not found etc) we just warn and continue
  try {
    const spreadsheetId = await getSheetId();
    // Try to write to a Config sheet — create if needed
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: 'Config!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [['XERO_REFRESH_TOKEN', token, new Date().toISOString()]] },
    }).catch(async () => {
      // Config sheet doesn't exist — try adding it
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: 'Config' } } }] },
      }).catch(() => {});
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'Config!A1',
        valueInputOption: 'RAW',
        requestBody: { values: [['XERO_REFRESH_TOKEN', token, new Date().toISOString()]] },
      });
    });
    console.log('[Xero] ✓ Refresh token saved to Bills/Config sheet');
  } catch(e) {
    console.warn('[Xero] Could not save to sheet:', e.message);
  }
}

// ── Load persisted refresh token from Google Sheets ───────────────────────────
async function loadPersistedToken() {
  try {
    const { google } = require('googleapis');
    const { getAuth } = require('./auth');
    const auth   = await getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const { getSheetId } = require('./ledger');
    const spreadsheetId = await getSheetId();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId, range: 'Config!A1:C1',
    });
    const row = res.data.values?.[0];
    if (row?.[0] === 'XERO_REFRESH_TOKEN' && row?.[1]) {
      console.log('[Xero] ✓ Loaded persisted refresh token from Bills/Config sheet');
      console.log('[Xero]   Saved at:', row[2]);
      return row[1];
    }
  } catch(e) {
    console.log('[Xero] No persisted token found in sheet:', e.message);
  }
  return null;
}

async function getValidAccessToken() {
  const expired = !tokenStore.expiresAt || Date.now() > tokenStore.expiresAt - 60000;
  if (!tokenStore.accessToken || expired) return await refreshAccessToken();
  return tokenStore.accessToken;
}

// ── Health ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  agent: 'Continental Agent 3', status: 'ok', timestamp: new Date().toISOString(),
  xero: {
    clientId:     !!process.env.XERO_CLIENT_ID,
    clientSecret: !!process.env.XERO_CLIENT_SECRET,
    redirectUri:  process.env.XERO_REDIRECT_URI,
    refreshToken: tokenStore.refreshToken ? '✓ set' : '✗ pending OAuth',
    tenantId:     tokenStore.tenantId     ? '✓ set' : '✗ pending OAuth',
  },
}));

// ── OAuth Flow ─────────────────────────────────────────────────────────────────
app.get('/xero/auth', (req, res) => {
  const params = new URLSearchParams({
    response_type: 'code', client_id: process.env.XERO_CLIENT_ID,
    redirect_uri: process.env.XERO_REDIRECT_URI, scope: SCOPES,
    state: 'continental-agent3',
  });
  res.redirect(`${XERO_AUTH_URL}?${params.toString()}`);
});

app.get('/xero/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error)                       return res.redirect(`/?error=${encodeURIComponent(error)}`);
  if (state !== 'continental-agent3') return res.status(400).send('Invalid state.');
  if (!code)                       return res.status(400).send('No auth code received.');

  try {
    const tokenRes = await axios.post(XERO_TOKEN_URL,
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.XERO_REDIRECT_URI }).toString(),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokenStore.accessToken  = tokenRes.data.access_token;
    tokenStore.refreshToken = tokenRes.data.refresh_token;
    tokenStore.expiresAt    = Date.now() + (tokenRes.data.expires_in * 1000);

    const connRes = await axios.get(XERO_CONNECT_URL, {
      headers: { Authorization: `Bearer ${tokenStore.accessToken}` },
    });
    tokenStore.tenantId = connRes.data[0].tenantId;
    const tenantName    = connRes.data[0].tenantName;
    console.log(`[Xero Callback] ✓ Connected: ${tenantName}`);
    res.redirect(`/?oauth=success&tenant=${encodeURIComponent(tenantName)}`);
  } catch (err) {
    res.redirect(`/?error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/xero/token', (req, res) => res.json({
  hasAccessToken:  !!tokenStore.accessToken,
  hasRefreshToken: !!tokenStore.refreshToken,
  hasTenantId:     !!tokenStore.tenantId,
  tenantId:        tokenStore.tenantId || null,
  expiresAt:       tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null,
  refreshToken:    tokenStore.refreshToken || 'NOT YET — complete OAuth flow',
  instruction:     tokenStore.refreshToken
    ? 'Copy refreshToken into XERO_REFRESH_TOKEN in Render ENV vars'
    : 'Visit /xero/auth first',
}));

// ── Handshake test ─────────────────────────────────────────────────────────────
app.get('/xero/test', async (req, res) => {
  const start = Date.now();
  if (!tokenStore.refreshToken)
    return res.json({ success: false, error: 'No refresh token. Visit /xero/auth first.' });
  try {
    const accessToken = await getValidAccessToken();
    const connRes = await axios.get(XERO_CONNECT_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    const tenant  = connRes.data[0];
    const orgRes  = await axios.get(`${XERO_API_BASE}/Organisation`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tokenStore.tenantId },
    });
    const org = orgRes.data.Organisations?.[0];
    res.json({
      success: true, durationMs: Date.now() - start,
      organisation: { name: org?.Name, country: org?.CountryCode, currency: org?.BaseCurrency },
      tenant: { tenantId: tenant?.tenantId, tenantName: tenant?.tenantName },
      tokenStatus: { hasRefreshToken: !!tokenStore.refreshToken, expiresAt: new Date(tokenStore.expiresAt).toISOString() },
    });
  } catch (err) {
    res.json({ success: false, durationMs: Date.now() - start, error: err.message });
  }
});

// ── GET /ready — list all READY rows from Bills sheet ─────────────────────────
app.get('/ready', async (req, res) => {
  try {
    const rows = await getReadyRows();
    res.json({ success: true, count: rows.length, rows });
  } catch (err) {
    console.error('[/ready]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /sync/:rowId — upload one READY record to Xero ───────────────────────
app.post('/sync/:rowId', async (req, res) => {
  const { rowId } = req.params;
  const start     = Date.now();

  if (!tokenStore.refreshToken)
    return res.status(400).json({ success: false, error: 'Xero not connected. Visit /xero/auth first.' });

  try {
    // Find the specific row
    const rows   = await getReadyRows();
    const record = rows.find(r => r.rowId === rowId);
    if (!record)
      return res.status(404).json({ success: false, error: `Row ${rowId} not found or not READY` });

    console.log(`\n[Agent 3] Syncing: ${record.contact} — ${record.date}`);

    const accessToken = await getValidAccessToken();
    const result      = await createSpendMoney(accessToken, tokenStore.tenantId, record);

    await markSynced(rowId, result.bankTransactionId);

    res.json({
      success:           true,
      rowId,
      durationMs:        Date.now() - start,
      xeroTransactionId: result.bankTransactionId,
      invoiceNumber:     result.invoiceNumber,
      status:            result.status,
      total:             result.total,
      contact:           record.contact,
      date:              record.date,
      attachmentId:      result.attachmentId   || null,
      attachmentName:    result.attachmentName || null,
    });

  } catch (err) {
    console.error(`[/sync/${rowId}] FAILED:`, err.message);
    if (err.response?.data) {
      console.error(`[/sync/${rowId}] Xero response:`, JSON.stringify(err.response.data, null, 2));
    }
    await markFailed(rowId, err.message).catch(() => {});
    const status = err.response?.status;
    const detail = err.response?.data;
    res.status(500).json({
      success: false, rowId, error: err.message, status, detail,
      hint: status === 401 ? 'Token expired — click Connect to Xero again'
          : status === 403 ? 'Missing scope — check Xero app Configuration'
          : status === 400 ? 'Validation error — check Xero payload in logs'
          : 'Check Render logs for detail',
    });
  }
});

// ── POST /sync-all — upload ALL READY records to Xero ─────────────────────────
app.post('/sync-all', async (req, res) => {
  if (!tokenStore.refreshToken)
    return res.status(400).json({ success: false, error: 'Xero not connected.' });

  try {
    const rows    = await getReadyRows();
    if (rows.length === 0)
      return res.json({ success: true, message: 'No READY rows to sync.', results: [] });

    console.log(`\n[Agent 3] Bulk sync: ${rows.length} record(s)`);
    const accessToken = await getValidAccessToken();
    const results     = [];

    for (const record of rows) {
      try {
        const result = await createSpendMoney(accessToken, tokenStore.tenantId, record);
        await markSynced(record.rowId, result.bankTransactionId);
        results.push({
          rowId:             record.rowId,
          success:           true,
          xeroTransactionId: result.bankTransactionId,
          contact:           record.contact,
          total:             result.total,
        });
        console.log(`[Agent 3] ✓ ${record.contact} → ${result.bankTransactionId}`);
      } catch (err) {
        await markFailed(record.rowId, err.message).catch(() => {});
        results.push({ rowId: record.rowId, success: false, error: err.message, contact: record.contact });
        console.error(`[Agent 3] ✗ ${record.contact}:`, err.message);
      }
    }

    const succeeded = results.filter(r => r.success).length;
    const failed    = results.filter(r => !r.success).length;
    console.log(`[Agent 3] Bulk sync done: ${succeeded} ok, ${failed} failed`);
    res.json({ success: true, total: rows.length, succeeded, failed, results });

  } catch (err) {
    console.error('[/sync-all]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /test-gemini kept for reference ───────────────────────────────────────
app.get('/xero/bank-accounts', async (req, res) => {
  if (!tokenStore.refreshToken)
    return res.json({ success: false, error: 'Not connected to Xero.' });
  try {
    const accessToken = await getValidAccessToken();
    const r = await axios.get(`${XERO_API_BASE}/Accounts`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Xero-tenant-id': tokenStore.tenantId },
      params: { Type: 'BANK' },
    });
    res.json({ success: true, accounts: r.data.Accounts });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const ok = v => v && v !== 'PENDING_OAUTH_FLOW' ? '✓' : '✗ PENDING';
  console.log('');
  console.log('┌──────────────────────────────────────────────────────┐');
  console.log('│       CONTINENTAL PROJECT — AGENT 3  (Phase 2)       │');
  console.log('│       Xero Spend Money Sync                          │');
  console.log('├──────────────────────────────────────────────────────┤');
  console.log(`│  http://localhost:${PORT}                                 │`);
  console.log(`│  Client ID     : ${ok(process.env.XERO_CLIENT_ID)}  XERO_CLIENT_ID             │`);
  console.log(`│  Client Secret : ${ok(process.env.XERO_CLIENT_SECRET)}  XERO_CLIENT_SECRET         │`);
  console.log(`│  Refresh Token : ${ok(process.env.XERO_REFRESH_TOKEN)}  XERO_REFRESH_TOKEN          │`);
  console.log(`│  Tenant ID     : ${ok(process.env.XERO_TENANT_ID)}  XERO_TENANT_ID              │`);
  console.log(`│  Expense Code  : ${process.env.XERO_EXPENSE_ACCOUNT_CODE || '429 (default)'}                              │`);
  console.log('├──────────────────────────────────────────────────────┤');
  console.log('│  Endpoints:                                          │');
  console.log('│    GET  /ready      → list READY rows                │');
  console.log('│    POST /sync/:id   → sync one row to Xero           │');
  console.log('│    POST /sync-all   → sync all READY rows            │');
  console.log('└──────────────────────────────────────────────────────┘');
  console.log('');
});
