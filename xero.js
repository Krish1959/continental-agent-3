// xero.js — Agent 3: Xero API operations
// Posts scanned receipts as Purchase Bills (ACCPAY) under Purchases → Bills
// Endpoint: POST /Invoices (not /BankTransactions)

const axios = require('axios');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

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

// ── Create Purchase Bill (ACCPAY) ─────────────────────────────────────────────
// Posts to /Invoices as ACCPAY DRAFT — appears under Purchases → Bills in Xero
async function createSpendMoney(accessToken, tenantId, record) {
  const api         = xeroAxios(accessToken, tenantId);
  const accountCode = process.env.XERO_EXPENSE_ACCOUNT_CODE || '603';
  const today       = new Date().toISOString().slice(0, 10);
  const date        = formatDate(record.date) || today;

  // Build line items
  const lineItems = record.lineItems.map(item => ({
    Description: item.description || 'General Expense',
    Quantity:    parseFloat(item.quantity)   || 1.0,
    UnitAmount:  parseFloat(item.unitAmount) || 0,
    AccountCode: accountCode,
  }));

  const payload = {
    Type:            'ACCPAY',           // Accounts Payable — Purchase Bill
    Status:          'DRAFT',            // Draft so staff can review in Xero
    LineAmountTypes: 'NoTax',            // Exact casing Xero requires
    Contact: {
      Name: (record.contact || 'Unknown Supplier').trim(),
    },
    Date:      date,
    DueDate:   date,                     // Same as date for petty cash
    Reference: record.invoiceRef || record.fileName || '',
    LineItems: lineItems,
    CurrencyCode: record.currency || 'SGD',
  };

  console.log('[Xero] POST /Invoices (ACCPAY DRAFT) payload:');
  console.log(JSON.stringify(payload, null, 2));

  let res;
  try {
    res = await api.post('/Invoices?summarizeErrors=false', {
      Invoices: [payload],
    });
  } catch (apiErr) {
    console.error('[Xero] ✗ API call failed:');
    console.error('[Xero]   HTTP Status :', apiErr.response?.status);
    console.error('[Xero]   Error Body  :', JSON.stringify(apiErr.response?.data, null, 2));
    throw apiErr;
  }

  const invoice = res.data.Invoices?.[0];
  if (!invoice) throw new Error('Xero returned empty Invoices array');

  if (invoice.ValidationErrors?.length > 0) {
    const msgs = invoice.ValidationErrors.map(e => e.Message).join(' | ');
    console.error('[Xero] Validation errors:', msgs);
    throw new Error(`Xero validation: ${msgs}`);
  }

  console.log('[Xero] ✓ Purchase Bill created:');
  console.log(`        InvoiceID  : ${invoice.InvoiceID}`);
  console.log(`        InvoiceNo  : ${invoice.InvoiceNumber}`);
  console.log(`        Status     : ${invoice.Status}`);
  console.log(`        Total      : ${invoice.Total} ${invoice.CurrencyCode}`);
  console.log(`        Supplier   : ${invoice.Contact?.Name}`);

  return {
    bankTransactionId: invoice.InvoiceID,   // reuse field name for ledger compatibility
    invoiceNumber:     invoice.InvoiceNumber,
    status:            invoice.Status,
    total:             invoice.Total,
    currencyCode:      invoice.CurrencyCode,
  };
}

// ── Date formatter ─────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (!dateStr || dateStr === 'xxx' || dateStr === 'n.a.') return today;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const year = parseInt(dateStr.slice(0, 4));
    if (year >= 2020 && year <= 2035) return dateStr;
    console.warn(`[Xero] Suspicious year "${dateStr}" — using today`);
    return today;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [d, m, y] = dateStr.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  const parsed = new Date(dateStr);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return today;
}

module.exports = { createSpendMoney };
