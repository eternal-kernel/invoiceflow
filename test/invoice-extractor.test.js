const test = require('node:test');
const assert = require('node:assert/strict');
const { extractInvoiceDraft, extractJsonString, buildPrompt } = require('../src/ai/invoice-extractor');

function createMockFetch(status, responseBody, onRequest) {
  return async (url, options) => {
    if (typeof onRequest === 'function') {
      onRequest(url, options);
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => responseBody,
      text: async () => (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)),
    };
  };
}

function createGeminiResponse(rawText) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: rawText }],
        },
      },
    ],
  };
}

test('valid one-item extraction', async () => {
  const modelOutput = JSON.stringify({
    recipientName: 'Alice Smith',
    recipientEmail: 'alice@example.com',
    currency: 'USD',
    dueDate: '2026-11-20',
    items: [
      {
        description: 'Web Design Consulting',
        quantity: 1,
        unitAmount: 150.0,
      },
    ],
    missingFields: [],
    ambiguities: [],
  });

  let fetchCalled = false;
  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput), (url, opts) => {
    fetchCalled = true;
    assert.ok(url.includes('generateContent'));
    assert.equal(opts.headers['x-goog-api-key'], 'test-key');
  });

  const result = await extractInvoiceDraft('Bill Alice Smith alice@example.com $150 for Web Design Consulting by Nov 20', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(fetchCalled, true);
  assert.equal(result.success, true);
  assert.equal(result.data.recipientName, 'Alice Smith');
  assert.equal(result.data.recipientEmail, 'alice@example.com');
  assert.equal(result.data.dueDate, '2026-11-20');
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].description, 'Web Design Consulting');
  assert.equal(result.data.items[0].unitAmount, 150.0);
});

test('valid multiple-item extraction', async () => {
  const modelOutput = JSON.stringify({
    recipientName: 'Acme Corp',
    recipientEmail: 'billing@acme.com',
    currency: 'USD',
    dueDate: null,
    items: [
      { description: 'Frontend Architecture', quantity: 2, unitAmount: 100.0 },
      { description: 'Code Review', quantity: 1, unitAmount: 75.5 },
    ],
    missingFields: [],
    ambiguities: [],
  });

  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput));

  const result = await extractInvoiceDraft('Invoice Acme Corp 2 Frontend Architecture at 100 and 1 Code Review at 75.50', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.items.length, 2);
  assert.equal(result.data.items[0].quantity, 2);
  assert.equal(result.data.items[1].unitAmount, 75.5);
});

test('missing email producing a clarification/missing field', async () => {
  const modelOutput = JSON.stringify({
    recipientName: 'Bob Builder',
    recipientEmail: null,
    currency: 'USD',
    dueDate: null,
    items: [
      {
        description: 'Construction Planning',
        quantity: 1,
        unitAmount: 500.0,
      },
    ],
    missingFields: ['recipientEmail'],
    ambiguities: [
      {
        field: 'recipientEmail',
        question: 'What email address should receive this invoice?',
      },
    ],
  });

  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput));

  const result = await extractInvoiceDraft('Invoice Bob Builder $500 for Construction Planning', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.recipientEmail, null);
  assert.ok(result.data.missingFields.includes('recipientEmail'));
  assert.equal(result.data.ambiguities.length, 1);
  assert.equal(result.data.ambiguities[0].field, 'recipientEmail');
  assert.ok(result.data.ambiguities[0].question.includes('What email address'));
});

test('ambiguous relative date using a supplied reference date', async () => {
  let capturedBody;
  const modelOutput = JSON.stringify({
    recipientName: 'Client X',
    recipientEmail: 'client@example.com',
    currency: 'USD',
    dueDate: null,
    items: [{ description: 'Strategy Work', quantity: 1, unitAmount: 300 }],
    missingFields: ['dueDate'],
    ambiguities: [
      {
        field: 'dueDate',
        question: 'Did you mean this Friday (2026-11-13) or next Friday (2026-11-20)?',
      },
    ],
  });

  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput), (url, opts) => {
    capturedBody = JSON.parse(opts.body);
  });

  const result = await extractInvoiceDraft('Invoice Client X due next Friday for $300 strategy work', {
    apiKey: 'test-key',
    referenceDate: '2026-11-09',
    fetch: mockFetch,
  });

  assert.equal(result.success, true);
  assert.ok(capturedBody.contents[0].parts[0].text.includes('REFERENCE DATE: 2026-11-09'));
  assert.equal(result.data.dueDate, null);
  assert.ok(result.data.ambiguities.some((a) => a.field === 'dueDate'));
});

test('unsupported currency', async () => {
  const modelOutput = JSON.stringify({
    recipientName: 'European Client',
    recipientEmail: 'client@euro.de',
    currency: 'EUR',
    dueDate: null,
    items: [{ description: 'Localization', quantity: 1, unitAmount: 200 }],
    missingFields: [],
    ambiguities: [],
  });

  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput));

  const result = await extractInvoiceDraft('Invoice European Client 200 EUR for Localization', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.message.includes('USD') || e.path.includes('currency')));
});

test('malformed JSON', async () => {
  const badJsonText = 'This is not valid JSON at all { recipient: ';
  const mockFetch = createMockFetch(200, createGeminiResponse(badJsonText));

  const result = await extractInvoiceDraft('Invoice test', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.message.includes('not valid JSON')));
});

test('markdown-wrapped JSON', async () => {
  const wrappedOutput = '```json\n' + JSON.stringify({
    recipientName: 'Charlie',
    recipientEmail: 'charlie@example.com',
    currency: 'USD',
    dueDate: '2026-11-30',
    items: [{ description: 'Logo Design', quantity: 1, unitAmount: 250 }],
    missingFields: [],
    ambiguities: [],
  }) + '\n```';

  const mockFetch = createMockFetch(200, createGeminiResponse(wrappedOutput));

  const result = await extractInvoiceDraft('Bill Charlie 250 for Logo Design', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, true);
  assert.equal(result.data.recipientName, 'Charlie');
  assert.equal(result.data.items[0].description, 'Logo Design');
});

test('invalid email', async () => {
  const modelOutput = JSON.stringify({
    recipientName: 'Dave',
    recipientEmail: 'not-a-valid-email',
    currency: 'USD',
    dueDate: null,
    items: [{ description: 'Support', quantity: 1, unitAmount: 80 }],
    missingFields: [],
    ambiguities: [],
  });

  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput));

  const result = await extractInvoiceDraft('Bill Dave at invalid email', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path.includes('recipientEmail')));
});

test('invalid amount', async () => {
  const modelOutput = JSON.stringify({
    recipientName: 'Dave',
    recipientEmail: 'dave@example.com',
    currency: 'USD',
    dueDate: null,
    items: [{ description: 'Support', quantity: 1, unitAmount: -50.0 }],
    missingFields: [],
    ambiguities: [],
  });

  const mockFetch = createMockFetch(200, createGeminiResponse(modelOutput));

  const result = await extractInvoiceDraft('Bill Dave negative 50', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.path.includes('unitAmount') || e.message.includes('greater than 0')));
});

test('Gemini HTTP error', async () => {
  const mockFetch = createMockFetch(500, {
    error: { code: 500, message: 'Internal server error in model execution' },
  });

  const result = await extractInvoiceDraft('Bill Someone $100', {
    apiKey: 'test-key',
    fetch: mockFetch,
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.some((e) => e.message.includes('500') && e.message.includes('Internal server error')));
});

test('empty input', async () => {
  const emptyResult = await extractInvoiceDraft('');
  assert.equal(emptyResult.success, false);
  assert.ok(emptyResult.errors.some((e) => e.message.includes('non-empty string')));

  const whitespaceResult = await extractInvoiceDraft('   \n\t  ');
  assert.equal(whitespaceResult.success, false);
  assert.ok(whitespaceResult.errors.some((e) => e.message.includes('non-empty string')));
});

test('API key missing', async () => {
  const originalKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  try {
    const result = await extractInvoiceDraft('Invoice Alice $100', { apiKey: '' });
    assert.equal(result.success, false);
    assert.ok(result.errors.some((e) => e.message.includes('GEMINI_API_KEY is required')));
  } finally {
    if (originalKey !== undefined) {
      process.env.GEMINI_API_KEY = originalKey;
    }
  }
});

test('no network calls during npm test', async () => {
  // Ensure that all automated tests in this file rely exclusively on mock fetch implementations
  // and that unmocked invocations are never triggered over the wire.
  let networkAttempted = false;
  const failingFetch = async () => {
    networkAttempted = true;
    throw new Error('Real network call attempted during test suite');
  };

  const emptyCall = await extractInvoiceDraft('', { fetch: failingFetch, apiKey: 'dummy' });
  assert.equal(emptyCall.success, false);
  assert.equal(networkAttempted, false, 'Validation should fail before fetch is called');

  const noKeyCall = await extractInvoiceDraft('Test', { fetch: failingFetch, apiKey: '' });
  assert.equal(noKeyCall.success, false);
  assert.equal(networkAttempted, false, 'Missing key should fail before fetch is called');
});
