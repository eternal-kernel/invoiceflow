'use strict';
/**
 * Invoice extraction evaluator.
 *
 * IMPORTANT: These evaluation cases were authored by the InvoiceFlow
 * development team and are NOT an independent benchmark.
 *
 * Usage:
 *   const { runEvaluation } = require('./invoice-evaluator');
 *   const report = await runEvaluation(extractorFn, cases);
 *
 * The extractor is fully injectable so this module can be tested offline.
 */

/**
 * Checks whether two items arrays match on description, quantity, and unitAmount.
 * Matching is order-sensitive and case-insensitive on description.
 * @param {object[]} actual
 * @param {object[]} expected
 * @returns {boolean}
 */
function itemsMatch(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;
  return expected.every((exp, i) => {
    const act = actual[i];
    if (!act) return false;
    const descMatch =
      typeof act.description === 'string' &&
      act.description.toLowerCase().includes(exp.description.toLowerCase());
    const qtyMatch = act.quantity === exp.quantity;
    const amtMatch = Math.abs(act.unitAmount - exp.unitAmount) < 0.001;
    return descMatch && qtyMatch && amtMatch;
  });
}

/**
 * Evaluates a single case result against its expected outcome.
 * Returns a detailed result object for reporting.
 *
 * @param {object} evalCase
 * @param {{ success: boolean, data?: object, errors?: object[] }} extractorResult
 * @returns {CaseResult}
 */
function evaluateCase(evalCase, extractorResult) {
  const { expected } = evalCase;
  const result = {
    id: evalCase.id,
    set: evalCase.set,
    description: evalCase.description,
    expectedType: expected.type,
    pass: false,
    status: 'failed',
    fieldResults: {},
    clarificationCorrect: null,
    notes: [],
  };

  // ── Rejection cases ───────────────────────────────────────────────────────
  if (expected.type === 'rejection') {
    result.pass = extractorResult.success === false;
    if (!result.pass) {
      result.notes.push(`Expected rejection but got success:true`);
    }
    return result;
  }

  // For valid / clarification: extractor must succeed
  if (!extractorResult.success) {
    result.notes.push(`Extractor failed: ${(extractorResult.errors || []).map(e => e.message).join('; ')}`);
    return result;
  }

  const data = extractorResult.data;

  // ── Valid cases: check every expected field ───────────────────────────────
  if (expected.type === 'valid') {
    const fields = ['recipientName', 'recipientEmail', 'currency', 'dueDate'];
    let allMatch = true;
    for (const field of fields) {
      if (expected[field] !== undefined) {
        const matches =
          field === 'recipientEmail'
            ? (data[field] || '').toLowerCase() === (expected[field] || '').toLowerCase()
            : data[field] === expected[field];
        result.fieldResults[field] = matches;
        if (!matches) {
          allMatch = false;
          result.notes.push(`${field}: expected "${expected[field]}", got "${data[field]}"`);
        }
      }
    }
    // Items
    if (expected.items) {
      const itemsOk = itemsMatch(data.items, expected.items);
      result.fieldResults.items = itemsOk;
      if (!itemsOk) {
        allMatch = false;
        result.notes.push(
          `items mismatch: expected ${JSON.stringify(expected.items)}, got ${JSON.stringify(data.items)}`,
        );
      }
    }
    result.pass = allMatch;
    return result;
  }

  // ── Clarification cases ───────────────────────────────────────────────────
  if (expected.type === 'clarification') {
    let clarifyOk = true;

    // missingFields check (if specified)
    if (expected.missingFields && expected.missingFields.length > 0) {
      const missing = data.missingFields || [];
      for (const f of expected.missingFields) {
        const present = missing.includes(f);
        result.fieldResults[`missingField:${f}`] = present;
        if (!present) {
          clarifyOk = false;
          result.notes.push(`Expected "${f}" in missingFields, but it was absent`);
        }
      }
    }

    // clarificationField: the primary field that must appear in ambiguities
    if (expected.clarificationField) {
      const ambiguities = data.ambiguities || [];
      const hasAmbiguity = ambiguities.some(a => a.field === expected.clarificationField);
      result.fieldResults[`ambiguity:${expected.clarificationField}`] = hasAmbiguity;
      result.clarificationCorrect = hasAmbiguity;
      if (!hasAmbiguity) {
        clarifyOk = false;
        result.notes.push(
          `Expected ambiguity for field "${expected.clarificationField}" but none found`,
        );
      }
    }

    // Tax / discount ambiguity check (optional, case 11/12)
    if (expected.ambiguityAbout) {
      const ambiguities = data.ambiguities || [];
      const hasIt = ambiguities.some(
        a =>
          a.field.toLowerCase().includes(expected.ambiguityAbout.toLowerCase()) ||
          (a.question && a.question.toLowerCase().includes(expected.ambiguityAbout.toLowerCase())),
      );
      result.fieldResults[`ambiguityAbout:${expected.ambiguityAbout}`] = hasIt;
      if (!hasIt) {
        clarifyOk = false;
        result.notes.push(`Expected ambiguity mentioning "${expected.ambiguityAbout}" but none found`);
      }
    }

    result.pass = clarifyOk;
    return result;
  }

  result.notes.push(`Unknown expected type: ${expected.type}`);
  return result;
}

/**
 * Runs the full evaluation against the given cases using the provided extractor.
 *
 * @param {Function} extractor - async (text, options) => { success, data?, errors? }
 * @param {object[]} cases - array of eval case objects
 * @returns {Promise<EvalReport>}
 */
async function runEvaluation(extractor, cases) {
  const caseResults = [];
  for (const evalCase of cases) {
    let extractorResult;
    try {
      extractorResult = await extractor(evalCase.input.text, {
        referenceDate: evalCase.input.referenceDate,
      });
      // Handle rate limits (429) gracefully on live APIs
      if (!extractorResult.success && extractorResult.errors && extractorResult.errors.some(e => e.message && e.message.includes('429'))) {
        await new Promise(r => setTimeout(r, 22000));
        extractorResult = await extractor(evalCase.input.text, {
          referenceDate: evalCase.input.referenceDate,
        });
      }
    } catch (err) {
      extractorResult = {
        success: false,
        errors: [{ path: 'exception', field: 'exception', message: err.message }],
      };
    }
    const result = evaluateCase(evalCase, extractorResult);
    const isRateLimitError =
      !extractorResult.success &&
      Array.isArray(extractorResult.errors) &&
      extractorResult.errors.some(e => e.message && e.message.includes('429'));
    if (isRateLimitError) {
      result.status = 'error';
      result.errorType = 'rate_limit';
      result.notes.push('Unresolved Gemini HTTP 429 rate limit after retry; excluded from accuracy denominators.');
    } else if (result.pass) {
      result.status = 'passed';
    }
    caseResults.push(result);
  }

  return buildReport(caseResults, cases);
}

/**
 * Builds a structured report from individual case results.
 * @param {object[]} caseResults
 * @param {object[]} cases
 * @returns {EvalReport}
 */
function buildReport(caseResults, cases) {
  const devResults = caseResults.filter(r => r.set === 'dev');
  const heldOutResults = caseResults.filter(r => r.set === 'held-out');

  function setMetrics(results) {
    const errors = results.filter(r => r.status === 'error').length;
    const evaluated = results.filter(r => r.status !== 'error');
    const total = evaluated.length;
    const fullyCorrect = evaluated.filter(r => r.pass).length;

    // Field-level accuracy: collect all boolean field results across all cases
    const fieldCounts = {};
    const fieldCorrects = {};
    for (const r of evaluated) {
      for (const [field, correct] of Object.entries(r.fieldResults)) {
        fieldCounts[field] = (fieldCounts[field] || 0) + 1;
        if (correct) fieldCorrects[field] = (fieldCorrects[field] || 0) + 1;
      }
    }
    const fieldAccuracy = {};
    for (const field of Object.keys(fieldCounts)) {
      fieldAccuracy[field] = {
        correct: fieldCorrects[field] || 0,
        total: fieldCounts[field],
        pct: total > 0 ? Math.round(((fieldCorrects[field] || 0) / fieldCounts[field]) * 100) : 0,
      };
    }

    // Clarification accuracy: only count cases where clarificationCorrect !== null
    const clarifyCases = evaluated.filter(r => r.clarificationCorrect !== null);
    const clarifyCorrect = clarifyCases.filter(r => r.clarificationCorrect === true).length;

    return {
      total,
      attempted: results.length,
      errors,
      fullyCorrect,
      fullyCorrectPct: total > 0 ? Math.round((fullyCorrect / total) * 100) : 0,
      fieldAccuracy,
      clarification: {
        total: clarifyCases.length,
        correct: clarifyCorrect,
        pct: clarifyCases.length > 0 ? Math.round((clarifyCorrect / clarifyCases.length) * 100) : 0,
      },
    };
  }

  return {
    disclaimer:
      'These evaluation cases were authored by the InvoiceFlow development team ' +
      'and are NOT an independent benchmark.',
    overall: setMetrics(caseResults),
    dev: setMetrics(devResults),
    heldOut: setMetrics(heldOutResults),
    cases: caseResults,
  };
}

/**
 * Formats a report as a human-readable string for CLI output.
 * @param {object} report
 * @returns {string}
 */
function formatReport(report) {
  const lines = [
    '╔══════════════════════════════════════════════════════╗',
    '║       Invoice Extraction Evaluation Report           ║',
    '╚══════════════════════════════════════════════════════╝',
    '',
    `⚠  ${report.disclaimer}`,
    '',
  ];

  function section(label, metrics) {
    lines.push(`── ${label} ──────────────────────────────────────────────`);
    lines.push(`  Fully correct : ${metrics.fullyCorrect}/${metrics.total} (${metrics.fullyCorrectPct}%)`);
    if (metrics.errors > 0) {
      lines.push(`  Unresolved errors: ${metrics.errors}/${metrics.attempted} (excluded from accuracy)`);
    }
    lines.push(`  Clarification : ${metrics.clarification.correct}/${metrics.clarification.total} (${metrics.clarification.pct}%)`);
    lines.push('  Field-level accuracy:');
    for (const [field, fa] of Object.entries(metrics.fieldAccuracy)) {
      lines.push(`    ${field.padEnd(32)} ${fa.correct}/${fa.total} (${fa.pct}%)`);
    }
    lines.push('');
  }

  section('Overall (all 30 cases)', report.overall);
  section('Development set (cases 1–20)', report.dev);
  section('Held-out set (cases 21–30)', report.heldOut);

  lines.push('── Case-by-case detail ──────────────────────────────────');
  for (const c of report.cases) {
    const icon = c.status === 'error' ? '!' : c.pass ? '✓' : '✗';
    lines.push(`  [${c.id.toString().padStart(2)}] ${icon} [${c.set.padEnd(8)}] ${c.description}`);
    if (c.notes.length > 0) {
      for (const n of c.notes) lines.push(`       ↳ ${n}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

module.exports = { runEvaluation, evaluateCase, buildReport, formatReport, itemsMatch };
