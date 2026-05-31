// ledger.js — Agent 3: Read READY rows from Bills sheet, mark SYNCED after upload
const { google }  = require('googleapis');
const { getAuth } = require('./auth');

const SHEET_NAME = 'Ledger';

// Column indices (0-based) — must match Agent 1 & 2 schema
const COL = {
  ROW_ID:          0,
  FILE_DRIVE_ID:   1,
  FILE_NAME:       2,
  UPLOAD_TS:       3,
  CONTACT:         4,
  DATE:            5,
  DUE_DATE:        6,
  INVOICE_REF:     7,
  CURRENCY:        8,
  AMOUNTS_ARE:     9,
  LINE_DESC:       10,
  LINE_QTY:        11,
  LINE_UNIT_PRICE: 12,
  LINE_ACCT_CODE:  13,
  LINE_TAX_RATE:   14,
  TRACKING_EMP:    15,
  GEMINI_STATUS:   16,
  OPENAI_STATUS:   17,
  CONSENSUS_MATCH: 18,
  XERO_SYNC:       19,
  XERO_INVOICE_ID: 20,
};

let _sheetId = null;

async function getSheets() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

async function getDrive() {
  const auth = await getAuth();
  return google.drive({ version: 'v3', auth });
}

// ── Auto-discover Bills sheet from Google Drive ───────────────────────────────
async function getSheetId() {
  if (_sheetId) return _sheetId;
  if (process.env.BILLS_SHEET_ID) {
    _sheetId = process.env.BILLS_SHEET_ID;
    return _sheetId;
  }
  const drive      = await getDrive();
  const folderName = process.env.GD_PARENT_FOLDER_NAME || 'Continental';

  const folderRes = await drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
    fields: 'files(id, name)', spaces: 'drive',
  });
  if (!folderRes.data.files.length)
    throw new Error(`Folder "${folderName}" not found. Has Agent 1 run at least once?`);

  const folderId = folderRes.data.files[0].id;
  const sheetRes = await drive.files.list({
    q: `name='Bills' and '${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
    fields: 'files(id, name)',
  });
  if (!sheetRes.data.files.length)
    throw new Error(`"Bills" sheet not found in "${folderName}". Run Agent 1 & 2 first.`);

  _sheetId = sheetRes.data.files[0].id;
  console.log(`[Ledger] ✓ Auto-discovered Bills sheet: ${_sheetId}`);
  return _sheetId;
}

// ── Get all READY rows ─────────────────────────────────────────────────────────
async function getReadyRows() {
  const sheets  = await getSheets();
  const sheetId = await getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows = res.data.values || [];
  const ready = [];

  // Group rows by Row_ID to handle multi-line receipts
  const groups = {};
  rows.forEach((row, i) => {
    const rowId = row[COL.ROW_ID];
    const sync  = row[COL.XERO_SYNC];
    if (!rowId && !sync) return; // skip empty rows

    // A READY row is the first line of a group
    if (rowId && sync === 'READY') {
      groups[rowId] = {
        rowIndex:   i + 2,
        rowId,
        fileId:     row[COL.FILE_DRIVE_ID],
        fileName:   row[COL.FILE_NAME],
        uploadTs:   row[COL.UPLOAD_TS],
        contact:    row[COL.CONTACT]    || 'Unknown Supplier',
        date:       row[COL.DATE]       || new Date().toISOString().slice(0, 10),
        invoiceRef: row[COL.INVOICE_REF]|| '',
        currency:   row[COL.CURRENCY]   || 'SGD',
        lineItems:  [{
          description: row[COL.LINE_DESC]       || 'General Expense',
          quantity:    parseFloat(row[COL.LINE_QTY])        || 1,
          unitAmount:  parseFloat(row[COL.LINE_UNIT_PRICE]) || 0,
          accountCode: row[COL.LINE_ACCT_CODE] === 'xxx'
                         ? (process.env.XERO_EXPENSE_ACCOUNT_CODE || '429')
                         : (row[COL.LINE_ACCT_CODE] || '429'),
        }],
      };
    } else if (!rowId && groups[Object.keys(groups).at(-1)]) {
      // Continuation row (multi-line item) — belongs to previous group
      const lastId = Object.keys(groups).at(-1);
      if (lastId) {
        groups[lastId].lineItems.push({
          description: row[COL.LINE_DESC]       || 'General Expense',
          quantity:    parseFloat(row[COL.LINE_QTY])        || 1,
          unitAmount:  parseFloat(row[COL.LINE_UNIT_PRICE]) || 0,
          accountCode: process.env.XERO_EXPENSE_ACCOUNT_CODE || '429',
        });
      }
    }
  });

  const result = Object.values(groups);
  console.log(`[Ledger] Found ${result.length} READY row(s) for Xero sync`);
  return result;
}

// ── Mark a row as SYNCED with Xero transaction ID ─────────────────────────────
async function markSynced(rowId, xeroTransactionId) {
  const sheets  = await getSheets();
  const sheetId = await getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows     = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[COL.ROW_ID] === rowId);
  if (rowIndex === -1) throw new Error(`Row ID ${rowId} not found in Bills sheet`);

  const sheetRow = rowIndex + 2; // 1-indexed + header

  // Update Xero_Sync_Status (col T = index 20) and Xero_Invoice_ID (col U = index 21)
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!T${sheetRow}:U${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['SYNCED', xeroTransactionId]] },
  });

  console.log(`[Ledger] ✓ Row ${rowId} → SYNCED (${xeroTransactionId})`);
}

// ── Mark a row as FAILED ───────────────────────────────────────────────────────
async function markFailed(rowId, errorMsg) {
  const sheets  = await getSheets();
  const sheetId = await getSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!A2:U`,
  });

  const rows     = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[COL.ROW_ID] === rowId);
  if (rowIndex === -1) return;

  const sheetRow = rowIndex + 2;
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_NAME}!T${sheetRow}:U${sheetRow}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['FAILED', errorMsg.slice(0, 100)]] },
  });
  console.log(`[Ledger] ✗ Row ${rowId} → FAILED`);
}

module.exports = { getReadyRows, markSynced, markFailed };
