const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../src/server');

/**
 * Helper to dispatch HTTP requests to the test server instance.
 */
function request(server, options, bodyData) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path: options.path,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: parsed,
        });
      });
    });

    req.on('error', (err) => {
      // In case connection was destroyed due to oversized payload, resolve gracefully if headers were sent
      if (err.code === 'ECONNRESET') {
        resolve({ statusCode: 413, body: null });
      } else {
        reject(err);
      }
    });

    if (bodyData !== undefined && bodyData !== null) {
      req.write(typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData));
    }
    req.end();
  });
}

test('GET /health returns 200 and status ok', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await request(server, { path: '/health', method: 'GET' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'ok' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('unknown route returns 404 Not Found', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const getRes = await request(server, { path: '/unknown-route', method: 'GET' });
    assert.equal(getRes.statusCode, 404);
    assert.deepEqual(getRes.body, { error: 'Not Found' });

    const postRes = await request(server, { path: '/unknown-route', method: 'POST' }, { some: 'data' });
    assert.equal(postRes.statusCode, 404);
    assert.deepEqual(postRes.body, { error: 'Not Found' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/invoice/parse with valid input returns 200 and extracted data', async () => {
  let capturedArgs = null;
  const mockExtractor = async (text, options) => {
    capturedArgs = { text, options };
    return {
      success: true,
      data: {
        recipientName: 'Alice Smith',
        recipientEmail: 'alice@example.com',
        currency: 'USD',
        dueDate: '2026-11-16',
        items: [{ description: 'web design', quantity: 1, unitAmount: 150 }],
        missingFields: [],
        ambiguities: [],
      },
    };
  };

  const server = createServer({ extractor: mockExtractor });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {
        text: 'Invoice Alice $150 for web design',
        referenceDate: '2026-11-09',
      }
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.recipientName, 'Alice Smith');
    assert.equal(res.body.data.dueDate, '2026-11-16');
    assert.deepEqual(capturedArgs, {
      text: 'Invoice Alice $150 for web design',
      options: { referenceDate: '2026-11-09' },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/invoice/parse with missing text returns 400', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const resEmpty = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      {}
    );
    assert.equal(resEmpty.statusCode, 400);
    assert.equal(resEmpty.body.success, false);
    assert.ok(resEmpty.body.errors.some((e) => e.path === 'text'));

    const resWhitespace = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      { text: '   ' }
    );
    assert.equal(resWhitespace.statusCode, 400);
    assert.equal(resWhitespace.body.success, false);
    assert.ok(resWhitespace.body.errors.some((e) => e.path === 'text'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/invoice/parse with malformed JSON returns 400', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      '{"text": "invalid json ...'
    );

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.errors.some((e) => e.message.includes('Invalid JSON payload')));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/invoice/parse with oversized body returns 413', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const largeText = 'a'.repeat(12 * 1024); // 12 KB (exceeds 10 KB limit)
    const res = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      JSON.stringify({ text: largeText })
    );

    assert.equal(res.statusCode, 413);
    if (res.body) {
      assert.equal(res.body.success, false);
      assert.ok(res.body.errors.some((e) => e.message.includes('10 KB limit')));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('non-POST methods on /api/invoice/parse return 405 Method Not Allowed', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const getRes = await request(server, { path: '/api/invoice/parse', method: 'GET' });
    assert.equal(getRes.statusCode, 405);
    assert.deepEqual(getRes.body, { error: 'Method Not Allowed' });
    assert.equal(getRes.headers.allow, 'POST');

    const putRes = await request(server, { path: '/api/invoice/parse', method: 'PUT' }, {});
    assert.equal(putRes.statusCode, 405);
    assert.deepEqual(putRes.body, { error: 'Method Not Allowed' });

    const deleteRes = await request(server, { path: '/api/invoice/parse', method: 'DELETE' });
    assert.equal(deleteRes.statusCode, 405);
    assert.deepEqual(deleteRes.body, { error: 'Method Not Allowed' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/invoice/parse with mocked Gemini API failure returns 502', async () => {
  const mockExtractor = async () => {
    return {
      success: false,
      errors: [
        {
          path: 'api',
          field: 'api',
          message: 'Gemini API error (HTTP 503: High demand)',
        },
      ],
    };
  };

  const server = createServer({ extractor: mockExtractor });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      { text: 'Invoice Alice $150' }
    );

    assert.equal(res.statusCode, 502);
    assert.equal(res.body.success, false);
    assert.ok(res.body.errors.some((e) => e.path === 'api'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('POST /api/invoice/parse with validation failure returns 400', async () => {
  const mockExtractor = async () => {
    return {
      success: false,
      errors: [
        {
          path: 'currency',
          field: 'currency',
          message: 'Currency must be USD',
        },
      ],
    };
  };

  const server = createServer({ extractor: mockExtractor });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const res = await request(
      server,
      {
        path: '/api/invoice/parse',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      { text: 'Invoice Alice 150 EUR' }
    );

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.errors.some((e) => e.path === 'currency'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
