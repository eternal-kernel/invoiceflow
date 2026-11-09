'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');

// Mock extractor and paypal to keep tests offline
const mockExtractor = async () => ({ success: true, data: { recipientName: 'Test' } });
const mockPaypal = async () => ({ success: true, data: { id: 'INV-TEST', status: 'DRAFT', links: [] } });

let server;
let baseUrl;

before(() => new Promise((resolve) => {
  server = createServer({ extractor: mockExtractor, paypalCreateDraft: mockPaypal });
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

after(() => new Promise((resolve) => server.close(resolve)));

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(baseUrl + path, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

describe('Static file serving', () => {
  it('GET / returns 200 with HTML content', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/html'), 'should be text/html');
    assert.ok(r.body.includes('InvoiceFlow'), 'should contain InvoiceFlow');
  });

  it('GET /styles.css returns 200 with CSS content-type', async () => {
    const r = await get('/styles.css');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('text/css'), 'should be text/css');
  });

  it('GET /app.js returns 200 with JS content-type', async () => {
    const r = await get('/app.js');
    assert.equal(r.status, 200);
    assert.ok(r.headers['content-type'].includes('application/javascript'), 'should be application/javascript');
  });

  it('GET /nonexistent.html returns 404', async () => {
    const r = await get('/nonexistent.html');
    assert.equal(r.status, 404);
  });

  it('GET /health still returns 200', async () => {
    const r = await get('/health');
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body);
    assert.equal(json.status, 'ok');
  });
});
