const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { extractInvoiceDraft } = require('./ai/invoice-extractor');
const { createDraftInvoice } = require('../src/paypal/invoice-service'); // default PayPal service

const PORT = process.env.PORT || 3000;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB

/**
 * Creates an HTTP server instance with configurable dependencies.
 * @param {object} [options={}]
 * @param {Function} [options.extractor] - Invoice extraction function for /api/invoice/parse.
 * @param {Function} [options.paypalCreateDraft] - Function to create PayPal draft invoices.
 * @returns {import('node:http').Server}
 */
function createServer(options = {}) {
  const extractor = options.extractor || extractInvoiceDraft;
  const paypalCreateDraft = options.paypalCreateDraft || createDraftInvoice;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // Health check endpoint
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Invoice extraction endpoint
    if (url.pathname === '/api/invoice/parse') {
      if (req.method !== 'POST') {
        res.writeHead(405, {
          'Content-Type': 'application/json',
          'Allow': 'POST',
        });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      handleJsonBody(req, res, async (parsed) => {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { status: 400, payload: { success: false, errors: [{ path: 'body', field: 'body', message: 'Payload must be a JSON object' }] } };
        }
        if (typeof parsed.text !== 'string' || parsed.text.trim().length === 0) {
          return { status: 400, payload: { success: false, errors: [{ path: 'text', field: 'text', message: 'text must be a non-empty string' }] } };
        }
        try {
          const result = await extractor(parsed.text, { referenceDate: parsed.referenceDate });
          if (result.success) {
            return { status: 200, payload: { success: true, data: result.data } };
          }
          const isApiFailure = result.errors && result.errors.some((err) => ['api', 'network', 'response', 'apiKey'].includes(err.path));
          const statusCode = isApiFailure ? 502 : 400;
          return { status: statusCode, payload: { success: false, errors: result.errors } };
        } catch (err) {
          return { status: 502, payload: { success: false, errors: [{ path: 'api', field: 'api', message: `Extraction failed: ${err.message}` }] } };
        }
      });
      return;
    }

    // New endpoint: create PayPal draft invoice with explicit confirmation
    if (url.pathname === '/api/invoice/create-draft') {
      if (req.method !== 'POST') {
        res.writeHead(405, {
          'Content-Type': 'application/json',
          'Allow': 'POST',
        });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
      }

      handleJsonBody(req, res, async (parsed) => {
        // Validate payload structure
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { status: 400, payload: { success: false, errors: [{ path: 'body', field: 'body', message: 'Payload must be a JSON object' }] } };
        }
        if (parsed.confirmed !== true) {
          return { status: 400, payload: { success: false, errors: [{ path: 'confirmed', field: 'confirmed', message: 'Confirmation flag must be true' }] } };
        }
        if (!parsed.invoice || typeof parsed.invoice !== 'object' || Array.isArray(parsed.invoice)) {
          return { status: 400, payload: { success: false, errors: [{ path: 'invoice', field: 'invoice', message: 'Invoice must be a JSON object' }] } };
        }
        // Call PayPal service – validation occurs inside the service before any network request
        const result = await paypalCreateDraft(parsed.invoice);
        if (result.success) {
          // Return safe subset – omit raw PayPal response, expose only needed identifiers
          const safeData = {
            id: result.data.id,
            status: result.data.status,
            links: result.data.links,
          };
          return { status: 201, payload: { success: true, data: safeData } };
        }
        // Determine if failure is PayPal/API/network (502) or validation (400)
        const isApiFailure = result.errors && result.errors.some((e) => ['api', 'network', 'response', 'oauth', 'credentials'].includes(e.path));
        const statusCode = isApiFailure ? 502 : 400;
        return { status: statusCode, payload: { success: false, errors: result.errors } };
      });
      return;
    }

    // Static file serving for GET requests
    if (req.method === 'GET') {
      // Serve root as index.html
      let filePath = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
      // Prevent path traversal – only serve files directly under public/
      if (filePath.includes('..') || filePath.includes('/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }
      const MIME = { html: 'text/html', css: 'text/css', js: 'application/javascript' };
      const ext = filePath.split('.').pop();
      const contentType = MIME[ext] || 'application/octet-stream';
      const absPath = path.join(__dirname, '..', 'public', filePath);
      fs.readFile(absPath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not Found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
      return;
    }

    // Default 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

/**
 * Helper to parse JSON body with size limit and invoke a handler returning {status, payload}.
 */
function handleJsonBody(req, res, asyncHandler) {
  let body = '';
  let bodySize = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    if (tooLarge) return;
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      tooLarge = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        errors: [{ path: 'body', field: 'body', message: 'Request body exceeds 10 KB limit' }],
      }));
      req.destroy();
      return;
    }
    body += chunk;
  });

  req.on('end', async () => {
    if (tooLarge) return;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        errors: [{ path: 'body', field: 'body', message: 'Invalid JSON payload' }],
      }));
      return;
    }
    const { status, payload } = await asyncHandler(parsed);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}

const defaultServer = createServer();

if (require.main === module) {
  defaultServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = defaultServer;
module.exports.createServer = createServer;
