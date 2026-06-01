// xero.js — Agent 3: Xero API operations
// Posts scanned receipts as Purchase Bills (ACCPAY) under Purchases → Bills
// Also attaches the original receipt image from Google Drive to each Xero bill

const axios  = require('axios');
const { google } = require('googleapis');
const { getAuth } = require('./auth');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

// ── Xero axios instance ───────────────────────────────────────────────────────
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

// ── Download receipt image from Google Drive as buffer ────────────────────────
async function downloadFromDrive(fileId) {
  const auth  = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata (name + mimeType)
  const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType' });
  const mimeType = meta.data.mimeType || 'image/jpeg';
  const fileName = meta.data.name;

  // Download as buffer
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  const buffer = Buffer.from(res.data);
  console.log(`[Drive] ✓ Downloaded "${fileName}" for Xero attachment (${(buffer.length/1024).toFixed(1)} KB)`);
  return { buffer, mimeType, fileName };
}

// ── Attach receipt image to Xero invoice ─────────────────────────────────────
async function attachReceiptToInvoice(accessToken, tenantId, invoiceId, fileId, fileName, mimeType, imageBuffer) {
  console.log(`[Xero] Attaching receipt image to invoice ${invoiceId}…`);

  // Xero attachment endpoint — binary upload
  const url = `${XERO_API_BASE}/Invoices/${invoiceId}/Attachments/${encodeURIComponent(fileName)}`;

  try {
    const res = await axios.post(url, imageBuffer, {
      headers: {
        Authorization:    `Bearer ${accessToken}`,
        'Xero-tenant-id': tenantId,
        'Content-Type':   mimeType,
        'Content-Length': imageBuffer.length,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    const attachment = res.data.Attachments?.[0];
    console.log(`[Xero] ✓ Receipt attached:`);
    console.log(`        AttachmentID : ${attachment?.AttachmentID}`);
    console.log(`        FileName     : ${attachment?.FileName}`);
    console.log(`        ContentLength: ${attachment?.ContentLength} bytes`);
    return attachment;

  } catch (err) {
    // Attachment failure is non-fatal — bill was already created
    console.error('[Xero] ⚠ Attachment failed (bill still created):', err.response?.data || err.message);
    return null;
  }
}

// ── Create Purchase Bill (ACCPAY) + attach receipt image ──────────────────────
async function createSpendMoney(accessToken, tenantId, record) {
  const api         = xeroAxios(accessToken, tenantId);
  const accountCode = process.env.XERO_EXPENSE_ACCOUNT_CODE || '603';
  const today       = new Date().toISOString().slice(0, 10);
  const date        = formatDate(record.date) || today;

  // ── Step 1: Build and post the invoice ──────────────────────────────────────
  const lineItems = record.lineItems.map(item => ({
    Description: item.description || 'General Expense',
    Quantity:    parseFloat(item.quantity)   || 1.0,
    UnitAmount:  parseFloat(item.unitAmount) || 0,
    AccountCode: accountCode,
  }));

  const payload = {
    Type:            'ACCPAY',
    Status:          'DRAFT',
    LineAmountTypes: 'NoTax',
    Contact: {
      Name: (record.contact || 'Unknown Supplier').trim(),
    },
    Date:         date,
    DueDate:      date,
    Reference:    record.invoiceRef || record.fileName || '',
    LineItems:    lineItems,
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
    console.error('[Xero] ✗ Invoice creation failed:');
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
  console.log(`        Status     : ${invoice.Status}`);
  console.log(`        Total      : ${invoice.Total} ${invoice.CurrencyCode}`);
  console.log(`        Supplier   : ${invoice.Contact?.Name}`);

  // ── Step 2: Attach receipt image from Google Drive ───────────────────────────
  let attachmentResult = null;
  if (record.fileId) {
    try {
      console.log(`[Xero] Fetching receipt image from Drive (fileId: ${record.fileId})…`);
      const { buffer, mimeType, fileName } = await downloadFromDrive(record.fileId);
      attachmentResult = await attachReceiptToInvoice(
        accessToken, tenantId,
        invoice.InvoiceID,
        record.fileId, fileName, mimeType, buffer
      );
    } catch (attachErr) {
      // Non-fatal — bill created successfully even if attachment fails
      console.error('[Xero] ⚠ Could not attach receipt image:', attachErr.message);
    }
  } else {
    console.warn('[Xero] No fileId in record — skipping receipt attachment');
  }

  return {
    bankTransactionId: invoice.InvoiceID,
    invoiceNumber:     invoice.InvoiceNumber,
    status:            invoice.Status,
    total:             invoice.Total,
    currencyCode:      invoice.CurrencyCode,
    attachmentId:      attachmentResult?.AttachmentID || null,
    attachmentName:    attachmentResult?.FileName     || null,
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
