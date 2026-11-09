const { parseInvoiceDraft } = require('../invoice/invoice-schema');

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
 * Strips markdown code fences from raw model text if present.
 * @param {string} rawText
 * @returns {string}
 */
function extractJsonString(rawText) {
  if (typeof rawText !== 'string') return '';
  const trimmed = rawText.trim();
  const fenceRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = trimmed.match(fenceRegex);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

/**
 * Builds the prompt instructing Gemini to extract structured invoice data.
 * @param {string} userText
 * @param {string} referenceDate
 * @returns {string}
 */
function buildPrompt(userText, referenceDate) {
  return `You are an invoice extraction engine. Extract structured invoice draft details from the user's natural language request.

REFERENCE DATE: ${referenceDate}
Use this reference date to resolve any relative dates (e.g., "in 7 days", "next Friday"). Never assume the current date is anything other than this reference date.

RULES:
1. Output MUST be valid JSON only. Do not include markdown code fences or conversational text.
2. Output JSON must strictly adhere to this schema:
{
  "recipientName": string or null,
  "recipientEmail": string or null,
  "currency": "USD",
  "dueDate": "YYYY-MM-DD" or null,
  "items": [
    {
      "description": string,
      "quantity": number,
      "unitAmount": number
    }
  ],
  "missingFields": [string],
  "ambiguities": [
    {
      "field": string,
      "question": string
    }
  ]
}
3. Currencies: Only "USD" is supported. If another currency is requested (e.g. EUR, GBP), set "currency" to that code so the system can evaluate it.
4. Line Items: Must have between 1 and 3 items. Each item must have:
   - "description": non-empty string describing the work or item.
   - "quantity": positive number greater than 0.
   - "unitAmount": positive number greater than 0 with at most 2 decimal places.
5. Tax and discounts: Do NOT include tax or discount fields. If mentioned, clarify them in ambiguities.
6. Negative or zero values: Do not accept negative or zero amounts/quantities.
7. NEVER guess missing information:
   - If recipient name is not mentioned, set recipientName to null and add "recipientName" to missingFields.
   - If recipient email is not mentioned, set recipientEmail to null, add "recipientEmail" to missingFields, and add a question in ambiguities:
     {"field": "recipientEmail", "question": "What email address should receive this invoice?"}
   - If a due date is ambiguous or relative date cannot be determined with certainty, set dueDate to null, add "dueDate" to missingFields, and ask a focused question in ambiguities.
   - If any required value is ambiguous, add an entry to ambiguities with "field" and a concise "question".

USER REQUEST:
${userText}
`;
}

/**
 * Extracts and validates an invoice draft from natural language text using Gemini.
 * @param {string} text
 * @param {object} [options={}]
 * @param {string} [options.apiKey]
 * @param {string} [options.model]
 * @param {string|Date} [options.referenceDate]
 * @param {Function} [options.fetch]
 * @param {string} [options.apiBaseUrl]
 * @returns {Promise<{ success: true, data: object } | { success: false, errors: Array<{ path: string, field: string, message: string }> }>}
 */
async function extractInvoiceDraft(text, options = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return {
      success: false,
      errors: [{ path: 'text', field: 'text', message: 'Input text must be a non-empty string' }],
    };
  }

  const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      success: false,
      errors: [{ path: 'apiKey', field: 'apiKey', message: 'GEMINI_API_KEY is required but not set' }],
    };
  }

  const model = options.model || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const fetchFn = options.fetch || globalThis.fetch;
  const apiBaseUrl = (options.apiBaseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');

  let referenceDate;
  if (options.referenceDate) {
    if (options.referenceDate instanceof Date) {
      referenceDate = options.referenceDate.toISOString().slice(0, 10);
    } else if (typeof options.referenceDate === 'string') {
      referenceDate = options.referenceDate;
    }
  }
  if (!referenceDate) {
    referenceDate = new Date().toISOString().slice(0, 10);
  }

  const promptText = buildPrompt(text, referenceDate);

  const requestPayload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: promptText }],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  };

  const endpointUrl = `${apiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`;

  let response;
  try {
    response = await fetchFn(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestPayload),
    });
  } catch (err) {
    return {
      success: false,
      errors: [{ path: 'network', field: 'network', message: `Network request to Gemini failed: ${err.message}` }],
    };
  }

  if (!response.ok) {
    let errorDetail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      if (errBody && errBody.error && errBody.error.message) {
        errorDetail = `HTTP ${response.status}: ${errBody.error.message}`;
      }
    } catch {
      // ignore
    }
    return {
      success: false,
      errors: [{ path: 'api', field: 'api', message: `Gemini API error (${errorDetail})` }],
    };
  }

  let responseData;
  try {
    responseData = await response.json();
  } catch (err) {
    return {
      success: false,
      errors: [{ path: 'response', field: 'response', message: 'Failed to parse Gemini response as JSON' }],
    };
  }

  const candidateText = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!candidateText || typeof candidateText !== 'string') {
    return {
      success: false,
      errors: [{ path: 'response', field: 'response', message: 'Gemini returned an empty or missing response' }],
    };
  }

  const cleanJsonText = extractJsonString(candidateText);
  let parsedJson;
  try {
    parsedJson = JSON.parse(cleanJsonText);
  } catch (err) {
    return {
      success: false,
      errors: [{ path: 'json', field: 'json', message: 'Model output is not valid JSON' }],
    };
  }

  const validation = parseInvoiceDraft(parsedJson);
  if (!validation.success) {
    return {
      success: false,
      errors: validation.errors,
    };
  }

  return {
    success: true,
    data: validation.data,
  };
}

module.exports = {
  extractInvoiceDraft,
  extractJsonString,
  buildPrompt,
};
