#!/usr/bin/env node

/**
 * PayPal Sandbox connectivity smoke test.
 * Creates a USD draft invoice using PayPal Invoicing API v2.
 */

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('[PayPal Smoke Test] Warning: Error reading .env file:', err.message);
  }
}

async function runSmokeTest() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const apiBaseUrl = (process.env.PAYPAL_API_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
  const testBuyerEmail = process.env.PAYPAL_TEST_BUYER_EMAIL;

  const missing = [];
  if (!clientId) missing.push('PAYPAL_CLIENT_ID');
  if (!clientSecret) missing.push('PAYPAL_CLIENT_SECRET');
  if (!testBuyerEmail) missing.push('PAYPAL_TEST_BUYER_EMAIL');

  if (missing.length > 0) {
    console.error(`[PayPal Smoke Test] Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('[PayPal Smoke Test] Define them in your environment or in .env (reference .env.example).');
    process.exit(1);
  }

  console.log(`[PayPal Smoke Test] Connecting to PayPal sandbox at: ${apiBaseUrl}`);
  console.log('[PayPal Smoke Test] Requesting OAuth access token...');

  let tokenData;
  try {
    const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
    const tokenRes = await fetch(`${apiBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      let errDetails;
      try {
        const json = JSON.parse(errText);
        errDetails = {
          error: json.error,
          error_description: json.error_description,
          message: json.message,
        };
      } catch {
        errDetails = errText.slice(0, 300);
      }
      console.error(`[PayPal Smoke Test] OAuth token request failed with HTTP ${tokenRes.status}.`);
      console.error('[PayPal Smoke Test] Error details:', errDetails);
      process.exit(1);
    }

    tokenData = await tokenRes.json();
  } catch (err) {
    console.error('[PayPal Smoke Test] Network error during OAuth request:', err.message);
    process.exit(1);
  }

  const accessToken = tokenData.access_token;
  if (!accessToken) {
    console.error('[PayPal Smoke Test] OAuth response did not contain an access_token.');
    process.exit(1);
  }

  console.log('[PayPal Smoke Test] OAuth token successfully obtained.');
  console.log(`[PayPal Smoke Test] Token type: ${tokenData.token_type || 'Bearer'}, Expires in: ${tokenData.expires_in || 'N/A'}s`);

  console.log('[PayPal Smoke Test] Creating draft invoice via /v2/invoicing/invoices...');

  const invoicePayload = {
    detail: {
      invoice_date: new Date().toISOString().slice(0, 10),
      currency_code: 'USD',
      note: 'InvoiceFlow test draft invoice',
      payment_term: {
        term_type: 'DUE_ON_RECEIPT',
      },
    },
    primary_recipients: [
      {
        billing_info: {
          email_address: testBuyerEmail,
        },
      },
    ],
    items: [
      {
        name: 'Development Services',
        description: 'Phase 2 Sandbox Connectivity Spike',
        quantity: '1',
        unit_amount: {
          currency_code: 'USD',
          value: '100.00',
        },
      },
    ],
  };

  try {
    const invoiceRes = await fetch(`${apiBaseUrl}/v2/invoicing/invoices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(invoicePayload),
    });

    const resText = await invoiceRes.text();
    let resData;
    try {
      resData = JSON.parse(resText);
    } catch {
      resData = resText;
    }

    if (!invoiceRes.ok) {
      console.error(`[PayPal Smoke Test] Failed to create draft invoice with HTTP ${invoiceRes.status}.`);
      console.error('[PayPal Smoke Test] Error details:', resData);
      process.exit(1);
    }

    console.log('[PayPal Smoke Test] Draft invoice created successfully.');
    console.log(`[PayPal Smoke Test] HTTP Status: ${invoiceRes.status}`);
    console.log(`[PayPal Smoke Test] Invoice ID: ${resData.id || 'N/A'}`);
    console.log(`[PayPal Smoke Test] Invoice Status: ${resData.status || 'N/A'}`);

    if (Array.isArray(resData.links)) {
      console.log('[PayPal Smoke Test] Returned Links:');
      for (const link of resData.links) {
        console.log(`  - [${link.rel}] (${link.method}): ${link.href}`);
      }
    }
  } catch (err) {
    console.error('[PayPal Smoke Test] Network error during draft invoice creation:', err.message);
    process.exit(1);
  }
}

runSmokeTest();
