const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/server');

/** Simple request helper for JSON */
function request(server, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...options,
      port: server.address().port,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('POST /api/invoice/create-draft', () => {
  let server;
  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  test('confirmed true with valid invoice creates draft (201)', async () => {
    const mockCreate = async (invoice) => ({
      success: true,
      data: { id: 'INV2-TEST', status: 'DRAFT', links: [{ rel: 'self', href: 'https://example.com' }], raw: {} },
    });
    server = createServer({ paypalCreateDraft: mockCreate });
    await new Promise((r) => server.listen(0, r));

    const payload = {
      confirmed: true,
      invoice: {
        recipientName: 'Alice Smith',
        recipientEmail: 'alice@example.com',
        currency: 'USD',
        dueDate: '2026-11-16',
        items: [{ description: 'Web design', quantity: 1, unitAmount: 150 }],
      },
    };
    const res = await request(server, { method: 'POST', path: '/api/invoice/create-draft' }, payload);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.ok(res.body.data.id);
    assert.equal(res.body.data.status, 'DRAFT');
    assert.ok(Array.isArray(res.body.data.links));
    // Ensure raw PayPal response not exposed
    assert.equal(res.body.data.raw, undefined);
  });

  test('confirmation false does not call PayPal (400)', async () => {
    let called = false;
    const mockCreate = async () => { called = true; return { success: true, data: {} }; };
    server = createServer({ paypalCreateDraft: mockCreate });
    await new Promise((r) => server.listen(0, r));
    const payload = { confirmed: false, invoice: {} };
    const res = await request(server, { method: 'POST', path: '/api/invoice/create-draft' }, payload);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false, 'PayPal createDraftInvoice should not be invoked');
  });

  test('missing confirmation flag (400)', async () => {
    let called = false;
    const mockCreate = async () => { called = true; return { success: true, data: {} }; };
    server = createServer({ paypalCreateDraft: mockCreate });
    await new Promise((r) => server.listen(0, r));
    const payload = { invoice: { recipientName: 'x', recipientEmail: 'x@example.com', currency: 'USD', items: [] } };
    const res = await request(server, { method: 'POST', path: '/api/invoice/create-draft' }, payload);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  });

  test('invalid invoice payload triggers validation error (400)', async () => {
    // mock service that returns validation failure without network call
    const mockCreate = async () => ({
      success: false,
      errors: [{ path: 'recipientEmail', field: 'recipientEmail', message: 'Invalid email' }],
    });
    server = createServer({ paypalCreateDraft: mockCreate });
    await new Promise((r) => server.listen(0, r));
    const payload = {
      confirmed: true,
      invoice: {
        recipientName: 'Alice',
        recipientEmail: 'not-an-email', // invalid
        currency: 'USD',
        items: [{ description: 'Design', quantity: 1, unitAmount: 150 }],
      },
    };
    const res = await request(server, { method: 'POST', path: '/api/invoice/create-draft' }, payload);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.errors.some(e => e.path === 'recipientEmail'));
  });

  test('PayPal service failure returns 502', async () => {
    const mockCreate = async () => ({
      success: false,
      errors: [{ path: 'api', field: 'api', message: 'PayPal API error' }],
    });
    server = createServer({ paypalCreateDraft: mockCreate });
    await new Promise((r) => server.listen(0, r));
    const payload = {
      confirmed: true,
      invoice: {
        recipientName: 'Alice Smith',
        recipientEmail: 'alice@example.com',
        currency: 'USD',
        dueDate: '2026-11-16',
        items: [{ description: 'Web design', quantity: 1, unitAmount: 150 }],
      },
    };
    const res = await request(server, { method: 'POST', path: '/api/invoice/create-draft' }, payload);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.ok(res.body.errors.some(e => e.path === 'api'));
  });

  test('sendInvoice is never called', async () => {
    let sendCalled = false;
    const mockCreate = async () => ({ success: true, data: { id: 'ID', status: 'DRAFT', links: [] } });
    const mockSend = async () => { sendCalled = true; };
    // Pass a service object with both but the endpoint only receives createDraft function
    server = createServer({ paypalCreateDraft: mockCreate, paypalSendInvoice: mockSend });
    await new Promise((r) => server.listen(0, r));
    const payload = {
      confirmed: true,
      invoice: {
        recipientName: 'Alice',
        recipientEmail: 'alice@example.com',
        currency: 'USD',
        items: [{ description: 'Web', quantity: 1, unitAmount: 100 }],
      },
    };
    const res = await request(server, { method: 'POST', path: '/api/invoice/create-draft' }, payload);
    assert.equal(res.statusCode, 201);
    assert.equal(sendCalled, false, 'sendInvoice should never be invoked by this endpoint');
  });
});
