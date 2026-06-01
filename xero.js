// xero.js — Agent 3: Xero API operations
// Handles: bank account lookup, contact find/create, Spend Money transaction

const axios = require('axios');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

// Cache bank account ID — fetched once, reused
let _bankAccountId = null;

// ── Axios helper with Xero headers ────────────────────────────────────────────
function xeroAxios(accessToken, tenantId) {
  return axios.create({
    baseURL: XERO_API_BASE,
    headers: {
      Authorization:    `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type':   'application/json',
      Accept:           'application/json',
    },
  });
}

// ── Get Bank Account ID for "Continental" petty cash account ──────────────────
async function getBankAccountId(accessToken, tenantId) {
  if (_bankAccountId) return _bankAccountId;

  const api = xeroAxios(accessToken, tenantId);
  const res = await api.get('/Accounts', { params: { Type: 'BANK' } });

  const accounts = res.data.Accounts || [];
  console.log(`[Xero] Bank accounts found: ${accounts.map(a => `${a.Name}(${a.AccountID})`).join(', ')}`);

  const target = accounts.find(a =>
    a.Name?.toLowerCase().includes('continental') ||
    a.Name?.toLowerCase().includes('petty')
  ) || accounts[0];

  if (!target) throw new Error('No bank account found in Xero. Create one first.');

  _bankAccountId = target.AccountID;
  console.log(`[Xero] ✓ Using bank account: "${target.Name}" → ${_bankAccountId}`);
  return _bankAccountId;
}

// ── Find or Create a Contact (supplier) ───────────────────────────────────────
async function findOrCreateContact(accessToken, tenantId, supplierName) {
  const api  = xeroAxios(accessToken, tenantId);
  const name = (supplierName || 'Unknown Supplier').trim();

  try {
    const res      = await api.get('/Contacts', { params: { searchTerm: name } });
    const contacts = res.data.Contacts || [];
    if (contacts.length > 0) {
      console.log(`[Xero] Found contact: "${contacts[0].Name}" (${contacts[0].ContactID})`);
      return contacts[0].ContactID;
    }
  } catch (e) {
    console.warn('[Xero] Contact search error:', e.message);
  }

  const createRes = await api.post('/Contacts', { Name: name });
  const created   = createRes.data.Contacts?.[0];
  if (!created) throw new Error('Failed to create Xero contact');
  console.log(`[Xero] ✓ Created contact: "${created.Name}" (${created.ContactID})`);
  return created.ContactID;
}

// ── Create Spend Money Bank Transaction ───────────────────────────────────────
async function createSpendMoney(accessToken, tenantId, record) {
  const api = xeroAxios(accessToken, tenantId);

  const bankAccountId = await getBankAccountId(accessToken, tenantId);
  const contactId     = await findOrCreateContact(accessToken, tenantId, record.contact);

  // Build line items — NO TaxType field
  // Xero will apply the account's default tax rate (Standard-Rated Purchases 9%)
  // from account 429 automatically
  const lineItems = record.lineItems.map(item => ({
    Description: item.description || 'General Expense',
    Quantity:    parseFloat(item.quantity)  || 1,
    UnitAmount:  parseFloat(item.unitAmount)|| 0,
    AccountCode: String(item.accountCode || process.env.XERO_EXPENSE_ACCOUNT_CODE || '429'),
    // TaxType intentionally omitted — let Xero use account default
  }));

  const payload = {
    Type:        'SPEND',
    Contact:     { ContactID: contactId },
    BankAccount: { AccountID: bankAccountId },
    Date:        formatDate(record.date),
    LineItems:   lineItems,
    LineAmountTypes: 'NOTAX', // simplest for demo — posts full amount, no tax split
    // NOTAX: records the exact amount paid (29.00 SGD) without tax recalculation
    // EXCLUSIVE would require net amount (26.61); INCLUSIVE rejected by Xero BankTransactions
    CurrencyCode:    record.currency || 'SGD',
    Reference:       record.invoiceRef || '',
  };

  console.log('[Xero] POST /BankTransactions payload:');
  console.log(JSON.stringify(payload, null, 2));

  // summarizeErrors=false returns individual field errors for debugging
  let res;
  try {
    res = await api.post('/BankTransactions?summarizeErrors=false', {
      BankTransactions: [payload],
    });
  } catch (apiErr) {
    // Log full Xero error response body for debugging
    console.error('[Xero] ✗ API call failed:');
    console.error('[Xero]   HTTP Status :', apiErr.response?.status);
    console.error('[Xero]   Error Body  :', JSON.stringify(apiErr.response?.data, null, 2));
    throw apiErr;
  }

  const tx = res.data.BankTransactions?.[0];
  if (!tx) throw new Error('Xero returned empty BankTransactions array');

  // Check for validation errors on the transaction itself
  if (tx.ValidationErrors?.length > 0) {
    const msgs = tx.ValidationErrors.map(e => e.Message).join(' | ');
    console.error('[Xero] Validation errors:', msgs);
    throw new Error(`Xero validation: ${msgs}`);
  }

  console.log(`[Xero] ✓ BankTransaction created:`);
  console.log(`        ID     : ${tx.BankTransactionID}`);
  console.log(`        Status : ${tx.Status}`);
  console.log(`        Total  : ${tx.Total} ${tx.CurrencyCode}`);

  return {
    bankTransactionId: tx.BankTransactionID,
    status:            tx.Status,
    total:             tx.Total,
    currencyCode:      tx.CurrencyCode,
  };
}

// ── Date formatter ─────────────────────────────────────────────────────────────
// Xero accepts YYYY-MM-DD. Validates year is reasonable (2020-2030).
function formatDate(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (!dateStr || dateStr === 'xxx' || dateStr === 'n.a.') {
    console.warn('[Xero] No date found — using today:', today);
    return today;
  }
  // YYYY-MM-DD — validate year is sensible
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const year = parseInt(dateStr.slice(0, 4));
    if (year >= 2020 && year <= 2035) return dateStr;
    // Year looks wrong (e.g. 2016 when receipt is from 2026) — log warning
    console.warn(`[Xero] Suspicious year in date "${dateStr}" — using today: ${today}`);
    return today;
  }
  // DD/MM/YYYY → YYYY-MM-DD
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // DD-MM-YYYY → YYYY-MM-DD
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split('-');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // Try native parse as fallback
  const parsed = new Date(dateStr);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  console.warn(`[Xero] Unrecognised date "${dateStr}" — using today`);
  return today;
}

module.exports = { createSpendMoney, getBankAccountId };
