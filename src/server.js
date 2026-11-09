const http = require('node:http');
const { extractInvoiceDraft } = require('./ai/invoice-extractor');

const PORT = process.env.PORT || 3000;
const MAX_BODY_SIZE = 10 * 1024; // 10 KB

/**
 * Creates an HTTP server instance with configurable dependencies.
 * @param {object} [options={}]
 * @param {Function} [options.extractor]
 * @returns {import('node:http').Server}
 */
function createServer(options = {}) {
  const extractor = options.extractor || extractInvoiceDraft;

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

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            errors: [{ path: 'body', field: 'body', message: 'Payload must be a JSON object' }],
          }));
          return;
        }

        if (typeof parsed.text !== 'string' || parsed.text.trim().length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            errors: [{ path: 'text', field: 'text', message: 'text must be a non-empty string' }],
          }));
          return;
        }

        try {
          const result = await extractor(parsed.text, {
            referenceDate: parsed.referenceDate,
          });

          if (result.success) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, data: result.data }));
            return;
          }

          const isApiFailure = result.errors && result.errors.some(
            (err) => err.path === 'api' || err.path === 'network' || err.path === 'response' || err.path === 'apiKey'
          );
          const statusCode = isApiFailure ? 502 : 400;

          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, errors: result.errors }));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            errors: [{ path: 'api', field: 'api', message: `Extraction failed: ${err.message}` }],
          }));
        }
      });

      return;
    }

    // Default 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

const defaultServer = createServer();

if (require.main === module) {
  defaultServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = defaultServer;
module.exports.createServer = createServer;
