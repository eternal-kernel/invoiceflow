#!/usr/bin/env node
'use strict';
/**
 * Live invoice extraction evaluator.
 * Calls the REAL Gemini API – never run during `npm test`.
 *
 * Usage:
 *   npm run evaluate:invoice
 *
 * Requires GEMINI_API_KEY to be set in .env or the environment.
 */

try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile();
} catch (err) {
  if (err.code !== 'ENOENT') console.warn('Warning reading .env:', err.message);
}

const { extractInvoiceDraft } = require('../src/ai/invoice-extractor');
const { ALL_CASES } = require('../test/fixtures/invoice-evaluation-cases');
const { runEvaluation, formatReport } = require('./invoice-evaluator');

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('ERROR: GEMINI_API_KEY is not set. Set it in .env before running the evaluator.');
    process.exit(1);
  }

  console.log(`Running evaluation over ${ALL_CASES.length} cases against live Gemini API…\n`);

  const report = await runEvaluation(extractInvoiceDraft, ALL_CASES);
  console.log(formatReport(report));

  // Exit non-zero if held-out accuracy drops below 60% (soft gate, not hard CI block)
  const heldOutPct = report.heldOut.fullyCorrectPct;
  if (heldOutPct < 60) {
    console.warn(`⚠  Held-out accuracy ${heldOutPct}% is below the 60% soft threshold.`);
    process.exit(1);
  }
})();
