const { parseValidatedInvoice } = require('../invoice/invoice-schema');

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('Warning: Error reading .env file:', err.message);
  }
}

/**
 * Obtains an OAuth 2.0 access token from PayPal using client credentials grant.
 * @param {object} [options={}]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {string} [options.apiBaseUrl]
 * @param {Function} [options.fetch]
 * @returns {Promise<{ success: true, data: { accessToken: string, tokenType: string, expiresIn: number } } | { success: false, errors: Array<{ path: string, field: string, message: string }> }>}
 */
async function getPayPalAccessToken(options = {}) {
  const clientId = options.clientId !== undefined ? options.clientId : process.env.PAYPAL_CLIENT_ID;
  const clientSecret = options.clientSecret !== undefined ? options.clientSecret : process.env.PAYPAL_CLIENT_SECRET;
  const apiBaseUrl = (options.apiBaseUrl || process.env.PAYPAL_API_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
  const fetchFn = options.fetch || globalThis.fetch;

  if (!clientId || !clientSecret) {
    return {
      success: false,
      errors: [
        {
          path: 'credentials',
          field: 'credentials',
          message: 'Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET',
        },
      ],
    };
  }

  const authHeader = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;

  let response;
  try {
    response = await fetchFn(`${apiBaseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: 'network',
          field: 'network',
          message: `Network error during PayPal OAuth request: ${err.message}`,
        },
      ],
    };
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: 'response',
          field: 'response',
          message: `Failed to read OAuth response: ${err.message}`,
        },
      ],
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      success: false,
      errors: [
        {
          path: 'response',
          field: 'response',
          message: `PayPal OAuth returned non-JSON response (HTTP ${response.status})`,
        },
      ],
    };
  }

  if (!response.ok) {
    const errorMsg = data.error_description || data.error || data.message || `HTTP ${response.status}`;
    return {
      success: false,
      errors: [
        {
          path: 'oauth',
          field: 'oauth',
          message: `PayPal OAuth error (HTTP ${response.status}): ${errorMsg}`,
        },
      ],
    };
  }

  if (!data.access_token) {
    return {
      success: false,
      errors: [
        {
          path: 'oauth',
          field: 'oauth',
          message: 'PayPal OAuth response did not contain an access_token',
        },
      ],
    };
  }

  return {
    success: true,
    data: {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresIn: data.expires_in,
    },
  };
}

/**
 * Validates invoice data and creates a draft invoice in PayPal.
 * Monetary values are strictly formatted as two-decimal strings.
 * @param {object} invoiceInput
 * @param {object} [options={}]
 * @param {string} [options.accessToken]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {string} [options.apiBaseUrl]
 * @param {Function} [options.fetch]
 * @returns {Promise<{ success: true, data: object } | { success: false, errors: Array<{ path: string, field: string, message: string }> }>}
 */
async function createDraftInvoice(invoiceInput, options = {}) {
  // 1. Validate with parseValidatedInvoice BEFORE making any PayPal calls
  const validation = parseValidatedInvoice(invoiceInput);
  if (!validation.success) {
    return {
      success: false,
      errors: validation.errors,
    };
  }

  const validInvoice = validation.data;
  const apiBaseUrl = (options.apiBaseUrl || process.env.PAYPAL_API_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
  const fetchFn = options.fetch || globalThis.fetch;

  // 2. Obtain access token if not passed in options
  let accessToken = options.accessToken;
  if (!accessToken) {
    const tokenResult = await getPayPalAccessToken(options);
    if (!tokenResult.success) {
      return tokenResult;
    }
    accessToken = tokenResult.data.accessToken;
  }

  // 3. Format payload for PayPal Invoicing API v2
  // Line item unitAmount must be formatted as string with exactly 2 decimal places.
  const items = validInvoice.items.map((item) => ({
    name: item.description,
    quantity: String(item.quantity),
    unit_amount: {
      currency_code: validInvoice.currency,
      value: item.unitAmount.toFixed(2),
    },
  }));

  const detail = {
    currency_code: validInvoice.currency,
    invoice_date: new Date().toISOString().slice(0, 10),
    payment_term: {
      term_type: 'DUE_ON_RECEIPT',
    },
  };

  if (validInvoice.dueDate) {
    detail.payment_term = {
      term_type: 'DUE_ON_DATE_SPECIFIED',
      due_date: validInvoice.dueDate,
    };
  }

  const primary_recipients = [
    {
      billing_info: {
        name: {
          given_name: validInvoice.recipientName,
        },
        email_address: validInvoice.recipientEmail,
      },
    },
  ];

  const payload = {
    detail,
    primary_recipients,
    items,
  };

  let response;
  try {
    response = await fetchFn(`${apiBaseUrl}/v2/invoicing/invoices`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: 'network',
          field: 'network',
          message: `Network error creating PayPal invoice: ${err.message}`,
        },
      ],
    };
  }

  let text;
  try {
    text = await response.text();
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: 'response',
          field: 'response',
          message: `Failed to read create invoice response: ${err.message}`,
        },
      ],
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      success: false,
      errors: [
        {
          path: 'response',
          field: 'response',
          message: `PayPal returned non-JSON response (HTTP ${response.status})`,
        },
      ],
    };
  }

  if (!response.ok) {
    const errorMsg = data.message || data.error_description || (Array.isArray(data.details) ? data.details.map((d) => d.description || d.issue).join('; ') : null) || `HTTP ${response.status}`;
    return {
      success: false,
      errors: [
        {
          path: 'api',
          field: 'api',
          message: `PayPal create invoice error (HTTP ${response.status}): ${errorMsg}`,
        },
      ],
    };
  }

  return {
    success: true,
    data: {
      id: data.id,
      status: data.status,
      detail: data.detail,
      links: data.links,
      raw: data,
    },
  };
}

/**
 * Sends an existing draft PayPal invoice to the recipient.
 * @param {string} invoiceId
 * @param {object} [options={}]
 * @param {string} [options.accessToken]
 * @param {string} [options.clientId]
 * @param {string} [options.clientSecret]
 * @param {string} [options.apiBaseUrl]
 * @param {Function} [options.fetch]
 * @param {boolean} [options.sendToRecipient=true]
 * @param {boolean} [options.sendToInvoicer=true]
 * @returns {Promise<{ success: true, data: object } | { success: false, errors: Array<{ path: string, field: string, message: string }> }>}
 */
async function sendInvoice(invoiceId, options = {}) {
  if (typeof invoiceId !== 'string' || invoiceId.trim().length === 0) {
    return {
      success: false,
      errors: [
        {
          path: 'invoiceId',
          field: 'invoiceId',
          message: 'invoiceId must be a non-empty string',
        },
      ],
    };
  }

  const cleanInvoiceId = invoiceId.trim();
  const apiBaseUrl = (options.apiBaseUrl || process.env.PAYPAL_API_BASE_URL || 'https://api-m.sandbox.paypal.com').replace(/\/+$/, '');
  const fetchFn = options.fetch || globalThis.fetch;

  let accessToken = options.accessToken;
  if (!accessToken) {
    const tokenResult = await getPayPalAccessToken(options);
    if (!tokenResult.success) {
      return tokenResult;
    }
    accessToken = tokenResult.data.accessToken;
  }

  const sendPayload = {
    send_to_invoicer: options.sendToInvoicer !== false,
    send_to_recipient: options.sendToRecipient !== false,
  };

  let response;
  try {
    response = await fetchFn(`${apiBaseUrl}/v2/invoicing/invoices/${encodeURIComponent(cleanInvoiceId)}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sendPayload),
    });
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: 'network',
          field: 'network',
          message: `Network error sending PayPal invoice: ${err.message}`,
        },
      ],
    };
  }

  let text = '';
  try {
    text = await response.text();
  } catch (err) {
    return {
      success: false,
      errors: [
        {
          path: 'response',
          field: 'response',
          message: `Failed to read send invoice response: ${err.message}`,
        },
      ],
    };
  }

  let data = null;
  if (text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      return {
        success: false,
        errors: [
          {
            path: 'response',
            field: 'response',
            message: `PayPal returned non-JSON response (HTTP ${response.status})`,
          },
        ],
      };
    }
  }

  if (!response.ok) {
    const errorMsg = data?.message || data?.error_description || (Array.isArray(data?.details) ? data.details.map((d) => d.description || d.issue).join('; ') : null) || `HTTP ${response.status}`;
    return {
      success: false,
      errors: [
        {
          path: 'api',
          field: 'api',
          message: `PayPal send invoice error (HTTP ${response.status}): ${errorMsg}`,
        },
      ],
    };
  }

  return {
    success: true,
    data: {
      invoiceId: cleanInvoiceId,
      status: 'SENT',
      links: data?.links || (data?.href ? [data] : []),
      raw: data,
    },
  };
}

module.exports = {
  getPayPalAccessToken,
  createDraftInvoice,
  sendInvoice,
};
