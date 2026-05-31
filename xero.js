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
  console.log(`[Xero] Bank accounts found: ${accounts.map(a => a.Name).join(', ')}`);

  // Find the "Continental" petty cash account (or any bank account)
  const target = accounts.find(a =>
    a.Name?.toLowerCase().includes('continental') ||
    a.Name?.toLowerCase().includes('petty')
  ) || accounts[0];

  if (!target) throw new Error('No bank account found in Xero. Create one first.');

  _bankAccountId = target.AccountID;
  console.log(`[Xero] ✓ Bank account: "${target.Name}" → ${_bankAccountId}`);
  return _bankAccountId;
}

// ── Find or Create a Contact (supplier) ───────────────────────────────────────
async function findOrCreateContact(accessToken, tenantId, supplierName) {
  const api  = xeroAxios(accessToken, tenantId);
  const name = supplierName || 'Unknown Supplier';

  // Search for existing contact
  try {
    const res = await api.get('/Contacts', {
      params: { searchTerm: name, includeArchived: false },
    });
    const contacts = res.data.Contacts || [];
    if (contacts.length > 0) {
      console.log(`[Xero] Found existing contact: "${contacts[0].Name}" (${contacts[0].ContactID})`);
      return contacts[0].ContactID;
    }
  } catch (e) {
    console.warn('[Xero] Contact search failed, will create new:', e.message);
  }

  // Create new contact
  const createRes = await api.post('/Contacts', {
    Name: name,
  });
  const created = createRes.data.Contacts?.[0];
  console.log(`[Xero] ✓ Created contact: "${created.Name}" (${created.ContactID})`);
  return created.ContactID;
}

// ── Create Spend Money Bank Transaction ───────────────────────────────────────
/**
 * Posts a Spend Money transaction to Xero.
 * @param {string} accessToken
 * @param {string} tenantId
 * @param {object} record - from ledger.js getReadyRows()
 * @returns {{ bankTransactionId, transactionNumber }}
 */
async function createSpendMoney(accessToken, tenantId, record) {
  const api = xeroAxios(accessToken, tenantId);

  // 1. Get bank account ID
  const bankAccountId = await getBankAccountId(accessToken, tenantId);

  // 2. Find or create supplier contact
  const contactId = await findOrCreateContact(accessToken, tenantId, record.contact);

  // 3. Build line items
  const taxType   = process.env.XERO_TAX_TYPE || 'INPUT2'; // Standard-Rated Purchases 9%
  const lineItems = record.lineItems.map(item => ({
    Description: item.description || 'General Expense',
    UnitAmount:  parseFloat(item.unitAmount) || 0,
    Quantity:    parseFloat(item.quantity)   || 1,
    AccountCode: item.accountCode || process.env.XERO_EXPENSE_ACCOUNT_CODE || '429',
    TaxType:     taxType,
  }));

  console.log(`[Xero] Creating Spend Money for "${record.contact}" — ${lineItems.length} line item(s)`);

  // 4. Post bank transaction
  const payload = {
    Type:       'SPEND',
    Contact:    { ContactID: contactId },
    BankAccount:{ AccountID: bankAccountId },
    Date:       record.date || new Date().toISOString().slice(0, 10),
    LineItems:  lineItems,
    LineAmountTypes: 'EXCLUSIVE', // unit amounts are net (ex-GST)
    CurrencyCode:    record.currency || 'SGD',
    Reference:       record.invoiceRef || record.fileName || '',
  };

  console.log('[Xero] Payload:', JSON.stringify(payload, null, 2));

  const res = await api.post('/BankTransactions', { BankTransactions: [payload] });

  const tx = res.data.BankTransactions?.[0];
  if (!tx) throw new Error('Xero returned no BankTransaction in response');

  if (tx.ValidationErrors?.length > 0) {
    const errMsg = tx.ValidationErrors.map(e => e.Message).join('; ');
    throw new Error(`Xero validation: ${errMsg}`);
  }

  console.log(`[Xero] ✓ Spend Money created → BankTransactionID: ${tx.BankTransactionID}`);
  return {
    bankTransactionId: tx.BankTransactionID,
    status:            tx.Status,
    total:             tx.Total,
    currencyCode:      tx.CurrencyCode,
  };
}

module.exports = { createSpendMoney, getBankAccountId };
