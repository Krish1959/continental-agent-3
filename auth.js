// auth.js — Google OAuth2 client (env-first, credentials.json fallback)
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

let _auth = null;

function loadCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  }
  const p = path.join(__dirname, 'credentials.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  throw new Error('No Google credentials found. Set GOOGLE_CREDENTIALS_JSON env var.');
}

async function getAuth() {
  if (_auth) return _auth;
  const raw  = loadCredentials();
  const cred = raw.web || raw.installed || raw;
  const tok  = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
  const oauth2 = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  oauth2.setCredentials({ refresh_token: tok.refresh_token });
  await oauth2.refreshAccessToken();
  _auth = oauth2;
  console.log('[Google Auth] ✓ Ready');
  return _auth;
}

module.exports = { getAuth };
