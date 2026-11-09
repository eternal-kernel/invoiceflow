const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getPayPalAccessToken,
  createDraftInvoice,
  sendInvoice,
} = require('../src/paypal/invoice-service');

function createMockFetch(routes) {
  return async (url, options = {}) => {
    for (const route of routes) {
      const methodMatches = !route.method || route.method === options.method;
      const urlMatches = typeof route.url === 'string' ? url.includes(route.url) : route.url.test(url);

      if (methodMatches && urlMatches) {
        if (route.throws) {
          throw new Error(route.throws);
        }

        if (typeof route.onRequest === 'function') {
          route.onRequest(url, options);
        }

        return {
          ok: route.status >= 200 && route.status < 300,
          status: route.status,
          text: async () => (typeof route.body === 'string' ? route.body : JSON.stringify(route.body)),
          json: async () => (typeof route.body === 'string' ? JSON.parse(route.body) : route.body),
        };
      }
    }

    throw new Error(`Unhandled mock route for ${options.method || 'GET'} ${url}`);
  };
}

const validInvoiceInput = {
  recipientName: 'Alice Smith',
  recipientEmail: 'alice@example.com',
  currency: 'USD',
  dueDate: '2026-11-20',
  items: [
    {
      description: 'Consulting Work',
      quantity: 1,
      unitAmount: 150.5,
    },
  ],
};

test('createDraftInvoice - success formats money as two-decimal string', async () => {
  let capturedPayload = null;

  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 200,
      body: { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 },
    },
    {
      url: '/v2/invoicing/invoices',
      method: 'POST',
      status: 201,
      onRequest: (url, opts) => {
        capturedPayload = JSON.parse(opts.body);
        assert.equal(opts.headers.Authorization, 'Bearer mock-access-token');
      },
      body: {
        id: 'INV2-TEST-1234',
        status: 'DRAFT',
        detail: { currency_code: 'USD' },
        links: [{ rel: 'self', href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST-1234' }],
      },
    },
  ]);

  const result = await createDraftInvoice(validInvoiceInput, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.id, 'INV2-TEST-1234');
  assert.equal(result.data.status, 'DRAFT');

  // Verify money was formatted as a two-decimal string
  assert.ok(capturedPayload);
  assert.equal(capturedPayload.items[0].unit_amount.value, '150.50');
  assert.equal(capturedPayload.items[0].quantity, '1');
  assert.equal(capturedPayload.detail.payment_term.due_date, '2026-11-20');
  assert.equal(capturedPayload.primary_recipients[0].billing_info.email_address, 'alice@example.com');
});

test('createDraftInvoice - validation failure rejects before calling PayPal', async () => {
  let networkCalled = false;
  const mockFetch = async () => {
    networkCalled = true;
    throw new Error('Should not make any network calls for invalid input');
  };

  const invalidInvoice = {
    recipientName: 'Alice',
    recipientEmail: null, // missing email
    currency: 'USD',
    items: [{ description: 'Work', quantity: 1, unitAmount: 100 }],
  };

  const result = await createDraftInvoice(invalidInvoice, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.equal(networkCalled, false);
  assert.ok(result.errors.some((e) => e.path.includes('recipientEmail')));
});

test('createDraftInvoice - missing credentials fails gracefully', async () => {
  const result = await createDraftInvoice(validInvoiceInput, {
    clientId: '',
    clientSecret: '',
    fetch: async () => {},
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.message.includes('PAYPAL_CLIENT_ID')));
});

test('createDraftInvoice - OAuth HTTP error handled', async () => {
  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 401,
      body: { error: 'invalid_client', error_description: 'Client Authentication failed' },
    },
  ]);

  const result = await createDraftInvoice(validInvoiceInput, {
    clientId: 'bad-client',
    clientSecret: 'bad-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'oauth' && e.message.includes('Client Authentication failed')));
});

test('createDraftInvoice - PayPal API HTTP error handled', async () => {
  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 200,
      body: { access_token: 'mock-access-token' },
    },
    {
      url: '/v2/invoicing/invoices',
      method: 'POST',
      status: 400,
      body: { message: 'Invalid recipient email format', name: 'INVALID_REQUEST' },
    },
  ]);

  const result = await createDraftInvoice(validInvoiceInput, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'api' && e.message.includes('Invalid recipient email format')));
});

test('createDraftInvoice - malformed JSON response handled', async () => {
  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 200,
      body: { access_token: 'mock-access-token' },
    },
    {
      url: '/v2/invoicing/invoices',
      method: 'POST',
      status: 201,
      body: '<html>Bad Gateway</html>',
    },
  ]);

  const result = await createDraftInvoice(validInvoiceInput, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'response' && e.message.includes('non-JSON')));
});

test('createDraftInvoice - network failure handled', async () => {
  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      throws: 'ECONNRESET: socket closed prematurely',
    },
  ]);

  const result = await createDraftInvoice(validInvoiceInput, {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'network' && e.message.includes('ECONNRESET')));
});

test('sendInvoice - success sends invoice and returns status SENT', async () => {
  let capturedBody = null;

  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 200,
      body: { access_token: 'mock-token' },
    },
    {
      url: '/v2/invoicing/invoices/INV2-TEST-1234/send',
      method: 'POST',
      status: 202,
      onRequest: (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        assert.equal(opts.headers.Authorization, 'Bearer mock-token');
      },
      body: {
        href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST-1234',
        rel: 'self',
        method: 'GET',
      },
    },
  ]);

  const result = await sendInvoice('INV2-TEST-1234', {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.invoiceId, 'INV2-TEST-1234');
  assert.equal(result.data.status, 'SENT');
  assert.deepEqual(capturedBody, {
    send_to_invoicer: true,
    send_to_recipient: true,
  });
});

test('sendInvoice - missing invoiceId is rejected', async () => {
  const resultEmpty = await sendInvoice('', { fetch: async () => {} });
  assert.equal(resultEmpty.success, false);
  assert.ok(resultEmpty.errors.some((e) => e.path === 'invoiceId'));

  const resultNull = await sendInvoice(null, { fetch: async () => {} });
  assert.equal(resultNull.success, false);
  assert.ok(resultNull.errors.some((e) => e.path === 'invoiceId'));
});

test('sendInvoice - PayPal HTTP error handled', async () => {
  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 200,
      body: { access_token: 'mock-token' },
    },
    {
      url: '/v2/invoicing/invoices/INV2-UNKNOWN/send',
      method: 'POST',
      status: 404,
      body: { message: 'Invoice not found', name: 'RESOURCE_NOT_FOUND' },
    },
  ]);

  const result = await sendInvoice('INV2-UNKNOWN', {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'api' && e.message.includes('Invoice not found')));
});

test('sendInvoice - network failure handled', async () => {
  const mockFetch = createMockFetch([
    {
      url: '/v1/oauth2/token',
      method: 'POST',
      status: 200,
      body: { access_token: 'mock-token' },
    },
    {
      url: '/v2/invoicing/invoices/INV2-TEST/send',
      method: 'POST',
      throws: 'ETIMEDOUT: Connection timed out',
    },
  ]);

  const result = await sendInvoice('INV2-TEST', {
    clientId: 'test-client',
    clientSecret: 'test-secret',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path === 'network' && e.message.includes('ETIMEDOUT')));
});
