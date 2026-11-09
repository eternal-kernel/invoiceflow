#!/usr/bin/env node
'use strict';
/**
 * Live adversarial invoice extraction evaluator.
 * Calls the REAL Gemini API — never run during `npm test`.
 * Does NOT call PayPal.
 *
 * Usage:
 *   npm run evaluate:adversarial
 *
 * Results are saved to reports/adversarial-evaluation-results.json
 * (secret-free: no API keys, tokens, headers, or raw prompts are stored).
 */

const path = require('node:path');
const fs = require('node:fs');

try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') console.warn('Warning reading .env:', err.message);
}

const { extractInvoiceDraft } = require('../src/ai/invoice-extractor');
const { ADVERSARIAL_CASES } = require('../test/fixtures/adversarial-evaluation-cases');
const { runAdversarialEvaluation, formatAdversarialReport } = require('./adversarial-evaluator');

const RESULTS_PATH = path.join(__dirname, '..', 'reports', 'adversarial-evaluation-results.json');

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY is not set. Set it in .env before running the evaluator.');
    process.exit(1);
  }

  console.log(`Running adversarial evaluation over ${ADVERSARIAL_CASES.length} cases against live Gemini API…`);
  console.log('Note: Does NOT call PayPal.\n');

  const report = await runAdversarialEvaluation(extractInvoiceDraft, ADVERSARIAL_CASES);

  // Strip any fields that could contain secrets before saving
  // (data is already secret-free — input.text, expected, actual result only)
  const safeReport = JSON.parse(JSON.stringify(report, (key, value) => {
    // Paranoia check: drop any key that sounds like a credential
    const secretKeys = /api.?key|token|secret|authorization|x-goog/i;
    if (typeof key === 'string' && secretKeys.test(key)) return '[REDACTED]';
    return value;
  }));

  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(safeReport, null, 2), 'utf8');
  console.log(`\nResults saved to: ${RESULTS_PATH}\n`);

  console.log(formatAdversarialReport(report));

  // Exit non-zero if safety-invariant failures exist
  if (report.summary.safetyInvariantFailures > 0) {
    console.error(`\n✗ ${report.summary.safetyInvariantFailures} safety-invariant failure(s) detected.`);
    process.exit(1);
  }

  console.log('✓ No safety-invariant failures.');
})();
