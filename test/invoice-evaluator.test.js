'use strict';
/**
 * Offline tests for the invoice evaluation harness.
 * These tests NEVER call Gemini, PayPal, or any network service.
 * All extractor responses are deterministic mocks.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateCase,
  buildReport,
  runEvaluation,
  formatReport,
  itemsMatch,
} = require('../scripts/invoice-evaluator');

const { ALL_CASES, DEV_CASES, HELD_OUT_CASES } = require('./fixtures/invoice-evaluation-cases');

// ── Helpers ──────────────────────────────────────────────────────────────────

function successResult(data) {
  return { success: true, data };
}

function failureResult(message = 'mock failure') {
  return { success: false, errors: [{ path: 'mock', field: 'mock', message }] };
}

const VALID_DATA = {
  recipientName: 'Alice Smith',
  recipientEmail: 'alice@example.com',
  currency: 'USD',
  dueDate: '2026-11-16',
  items: [{ description: 'web design', quantity: 1, unitAmount: 150 }],
  missingFields: [],
  ambiguities: [],
};

// ── itemsMatch ────────────────────────────────────────────────────────────────

describe('itemsMatch', () => {
  it('returns true for matching single-item arrays', () => {
    assert.ok(
      itemsMatch(
        [{ description: 'web design', quantity: 1, unitAmount: 150 }],
        [{ description: 'web design', quantity: 1, unitAmount: 150 }],
      ),
    );
  });

  it('description match is case-insensitive / substring', () => {
    assert.ok(
      itemsMatch(
        [{ description: 'Logo Design & Identity', quantity: 1, unitAmount: 100 }],
        [{ description: 'logo design', quantity: 1, unitAmount: 100 }],
      ),
    );
  });

  it('returns false for different quantities', () => {
    assert.equal(
      itemsMatch(
        [{ description: 'consulting', quantity: 2, unitAmount: 100 }],
        [{ description: 'consulting', quantity: 1, unitAmount: 100 }],
      ),
      false,
    );
  });

  it('returns false for different amounts', () => {
    assert.equal(
      itemsMatch(
        [{ description: 'consulting', quantity: 1, unitAmount: 99 }],
        [{ description: 'consulting', quantity: 1, unitAmount: 100 }],
      ),
      false,
    );
  });

  it('returns false for different array lengths', () => {
    assert.equal(
      itemsMatch(
        [{ description: 'a', quantity: 1, unitAmount: 10 }],
        [
          { description: 'a', quantity: 1, unitAmount: 10 },
          { description: 'b', quantity: 1, unitAmount: 20 },
        ],
      ),
      false,
    );
  });

  it('handles floating-point amounts within tolerance', () => {
    assert.ok(
      itemsMatch(
        [{ description: 'item', quantity: 1, unitAmount: 99.990001 }],
        [{ description: 'item', quantity: 1, unitAmount: 99.99 }],
      ),
    );
  });

  it('returns false for non-arrays', () => {
    assert.equal(itemsMatch(null, []), false);
    assert.equal(itemsMatch([], null), false);
  });
});

// ── evaluateCase – valid type ─────────────────────────────────────────────────

describe('evaluateCase – valid expected type', () => {
  const validCase = ALL_CASES.find(c => c.id === 1); // case 1

  it('passes when all fields match', () => {
    const r = evaluateCase(validCase, successResult(VALID_DATA));
    assert.equal(r.pass, true);
    assert.equal(r.notes.length, 0);
  });

  it('fails when recipientName differs', () => {
    const data = { ...VALID_DATA, recipientName: 'Wrong Name' };
    const r = evaluateCase(validCase, successResult(data));
    assert.equal(r.pass, false);
    assert.ok(r.notes.some(n => n.includes('recipientName')));
  });

  it('fails when dueDate differs', () => {
    const data = { ...VALID_DATA, dueDate: '2099-01-01' };
    const r = evaluateCase(validCase, successResult(data));
    assert.equal(r.pass, false);
    assert.ok(r.notes.some(n => n.includes('dueDate')));
  });

  it('fails when items differ', () => {
    const data = { ...VALID_DATA, items: [{ description: 'web design', quantity: 1, unitAmount: 999 }] };
    const r = evaluateCase(validCase, successResult(data));
    assert.equal(r.pass, false);
    assert.ok(r.notes.some(n => n.includes('items')));
  });

  it('email match is case-insensitive', () => {
    const data = { ...VALID_DATA, recipientEmail: 'ALICE@EXAMPLE.COM' };
    const r = evaluateCase(validCase, successResult(data));
    assert.equal(r.fieldResults.recipientEmail, true);
  });

  it('fails when extractor returns failure', () => {
    const r = evaluateCase(validCase, failureResult('API error'));
    assert.equal(r.pass, false);
    assert.ok(r.notes.some(n => n.includes('API error')));
  });
});

// ── evaluateCase – rejection type ─────────────────────────────────────────────

describe('evaluateCase – rejection expected type', () => {
  const rejCase = ALL_CASES.find(c => c.id === 10); // EUR currency

  it('passes when extractor returns failure', () => {
    const r = evaluateCase(rejCase, failureResult('Currency must be USD'));
    assert.equal(r.pass, true);
  });

  it('fails when extractor returns success', () => {
    const r = evaluateCase(rejCase, successResult({ ...VALID_DATA, currency: 'EUR' }));
    assert.equal(r.pass, false);
    assert.ok(r.notes[0].includes('Expected rejection'));
  });
});

// ── evaluateCase – clarification type ────────────────────────────────────────

describe('evaluateCase – clarification expected type', () => {
  const clarifCase = ALL_CASES.find(c => c.id === 6); // missing email

  const clarifData = {
    ...VALID_DATA,
    recipientEmail: null,
    missingFields: ['recipientEmail'],
    ambiguities: [{ field: 'recipientEmail', question: 'What email should receive this invoice?' }],
  };

  it('passes when missingFields and ambiguity are present', () => {
    const r = evaluateCase(clarifCase, successResult(clarifData));
    assert.equal(r.pass, true);
    assert.equal(r.clarificationCorrect, true);
  });

  it('fails when missingFields is empty', () => {
    const data = { ...clarifData, missingFields: [] };
    const r = evaluateCase(clarifCase, successResult(data));
    assert.equal(r.pass, false);
  });

  it('fails when ambiguity field is missing', () => {
    const data = { ...clarifData, ambiguities: [] };
    const r = evaluateCase(clarifCase, successResult(data));
    assert.equal(r.pass, false);
    assert.equal(r.clarificationCorrect, false);
  });

  it('marks clarificationCorrect=null for rejection cases (not applicable)', () => {
    const rejCase = ALL_CASES.find(c => c.id === 10);
    const r = evaluateCase(rejCase, failureResult());
    assert.equal(r.clarificationCorrect, null);
  });
});

// ── evaluateCase – tax/discount ambiguity (cases 11, 12) ─────────────────────

describe('evaluateCase – tax and discount ambiguity', () => {
  const taxCase = ALL_CASES.find(c => c.id === 11);

  it('passes when ambiguities mention tax', () => {
    const data = {
      ...VALID_DATA,
      missingFields: [],
      ambiguities: [{ field: 'tax', question: 'Should tax be included?' }],
    };
    const r = evaluateCase(taxCase, successResult(data));
    assert.equal(r.pass, true);
  });

  it('fails when ambiguities do not mention tax', () => {
    const data = { ...VALID_DATA, missingFields: [], ambiguities: [] };
    const r = evaluateCase(taxCase, successResult(data));
    assert.equal(r.pass, false);
  });
});

// ── runEvaluation – async runner ──────────────────────────────────────────────

describe('runEvaluation', () => {
  it('returns a report with case results for each input case', async () => {
    const cases = ALL_CASES.slice(0, 3);
    // Mock extractor: always fail (safe offline)
    const mockExtractor = async () => failureResult('mock');
    const report = await runEvaluation(mockExtractor, cases);
    assert.equal(report.cases.length, 3);
    assert.ok(typeof report.disclaimer === 'string');
  });

  it('handles extractor throwing an exception gracefully', async () => {
    const cases = [ALL_CASES[0]];
    const throwingExtractor = async () => { throw new Error('simulated crash'); };
    const report = await runEvaluation(throwingExtractor, cases);
    assert.equal(report.cases[0].pass, false);
    assert.ok(report.cases[0].notes[0].includes('simulated crash'));
  });

  it('counts fully correct cases correctly', async () => {
    // Use only valid-type cases; mock extractor returns perfect answers for each
    const validCases = ALL_CASES.filter(c => c.expected.type === 'valid');
    const mockExtractor = async (text, opts) => {
      const ec = validCases.find(c => c.input.text === text);
      if (!ec) return failureResult('not found');
      const { recipientName, recipientEmail, currency, dueDate, items } = ec.expected;
      return successResult({ recipientName, recipientEmail, currency, dueDate, items, missingFields: [], ambiguities: [] });
    };
    const report = await runEvaluation(mockExtractor, validCases);
    assert.equal(report.overall.fullyCorrect, validCases.length);
  });

  it('reports clarification accuracy separately from overall accuracy', async () => {
    const clarCases = ALL_CASES.filter(c => c.expected.type === 'clarification' && c.expected.clarificationField);
    const mockExtractor = async (text, opts) => {
      const ec = clarCases.find(c => c.input.text === text);
      if (!ec) return failureResult();
      // Return data with correct missingFields and ambiguities
      return successResult({
        ...VALID_DATA,
        missingFields: ec.expected.missingFields || [],
        ambiguities: ec.expected.clarificationField
          ? [{ field: ec.expected.clarificationField, question: 'Please clarify.' }]
          : [],
      });
    };
    const report = await runEvaluation(mockExtractor, clarCases);
    assert.equal(report.overall.clarification.total, clarCases.length);
    assert.equal(report.overall.clarification.correct, clarCases.length);
    assert.equal(report.overall.clarification.pct, 100);
  });

  it('classifies unresolved 429 responses as errors excluded from accuracy', async () => {
    const cases = [ALL_CASES[0]];
    const rateLimitedExtractor = async () => failureResult('Gemini HTTP 429: quota exceeded');
    const report = await runEvaluation(rateLimitedExtractor, cases);

    assert.equal(report.cases[0].status, 'error');
    assert.equal(report.cases[0].errorType, 'rate_limit');
    assert.equal(report.overall.attempted, 1);
    assert.equal(report.overall.errors, 1);
    assert.equal(report.overall.total, 0);
    assert.equal(report.overall.fullyCorrect, 0);
  });

  it('separates dev and held-out sets correctly', async () => {
    const mockExtractor = async () => failureResult();
    const report = await runEvaluation(mockExtractor, ALL_CASES);
    assert.equal(report.dev.total, DEV_CASES.length);
    assert.equal(report.heldOut.total, HELD_OUT_CASES.length);
    assert.equal(report.overall.total, ALL_CASES.length);
  });
});

// ── buildReport ───────────────────────────────────────────────────────────────

describe('buildReport', () => {
  it('computes correct overall percentage when all cases pass', () => {
    const fakeResults = ALL_CASES.map(c => ({
      id: c.id,
      set: c.set,
      description: c.description,
      pass: true,
      fieldResults: {},
      clarificationCorrect: null,
      notes: [],
      expectedType: c.expected.type,
    }));
    const report = buildReport(fakeResults, ALL_CASES);
    assert.equal(report.overall.fullyCorrectPct, 100);
    assert.equal(report.dev.fullyCorrectPct, 100);
    assert.equal(report.heldOut.fullyCorrectPct, 100);
  });

  it('reports zero percent when no cases pass', () => {
    const fakeResults = ALL_CASES.map(c => ({
      id: c.id,
      set: c.set,
      description: c.description,
      pass: false,
      fieldResults: {},
      clarificationCorrect: null,
      notes: ['forced failure'],
      expectedType: c.expected.type,
    }));
    const report = buildReport(fakeResults, ALL_CASES);
    assert.equal(report.overall.fullyCorrectPct, 0);
  });

  it('contains the disclaimer string', () => {
    const report = buildReport([], []);
    assert.ok(report.disclaimer.includes('NOT an independent benchmark'));
  });
});

// ── formatReport ──────────────────────────────────────────────────────────────

describe('formatReport', () => {
  it('includes header and disclaimer', () => {
    const mockReport = {
      disclaimer: 'Test disclaimer',
      overall: { total: 2, fullyCorrect: 1, fullyCorrectPct: 50, fieldAccuracy: {}, clarification: { total: 0, correct: 0, pct: 0 } },
      dev: { total: 1, fullyCorrect: 1, fullyCorrectPct: 100, fieldAccuracy: {}, clarification: { total: 0, correct: 0, pct: 0 } },
      heldOut: { total: 1, fullyCorrect: 0, fullyCorrectPct: 0, fieldAccuracy: {}, clarification: { total: 0, correct: 0, pct: 0 } },
      cases: [
        { id: 1, set: 'dev', description: 'Test case', pass: true, notes: [], expectedType: 'valid' },
        { id: 2, set: 'held-out', description: 'Failed case', pass: false, notes: ['reason'], expectedType: 'valid' },
      ],
    };
    const output = formatReport(mockReport);
    assert.ok(output.includes('Invoice Extraction Evaluation'));
    assert.ok(output.includes('Test disclaimer'));
    assert.ok(output.includes('50%'));
    assert.ok(output.includes('Failed case'));
    assert.ok(output.includes('reason'));
  });
});

// ── Fixture integrity checks ──────────────────────────────────────────────────

describe('Fixture integrity', () => {
  it('has exactly 30 cases', () => {
    assert.equal(ALL_CASES.length, 30);
  });

  it('has 20 dev cases and 10 held-out cases', () => {
    assert.equal(DEV_CASES.length, 20);
    assert.equal(HELD_OUT_CASES.length, 10);
  });

  it('case IDs are sequential 1–30', () => {
    const ids = ALL_CASES.map(c => c.id);
    for (let i = 1; i <= 30; i++) assert.ok(ids.includes(i), `Missing case id ${i}`);
  });

  it('every dev case has set="dev"', () => {
    assert.ok(DEV_CASES.every(c => c.set === 'dev'));
  });

  it('every held-out case has set="held-out"', () => {
    assert.ok(HELD_OUT_CASES.every(c => c.set === 'held-out'));
  });

  it('every case has a non-empty description and input.text', () => {
    for (const c of ALL_CASES) {
      assert.ok(c.description && c.description.length > 0, `Case ${c.id} missing description`);
      assert.ok(c.input && c.input.text && c.input.text.length > 0, `Case ${c.id} missing input.text`);
    }
  });

  it('every case has a valid expected.type', () => {
    const validTypes = new Set(['valid', 'clarification', 'rejection']);
    for (const c of ALL_CASES) {
      assert.ok(validTypes.has(c.expected.type), `Case ${c.id} has unknown type "${c.expected.type}"`);
    }
  });

  it('valid cases have all required expected fields', () => {
    for (const c of ALL_CASES.filter(c => c.expected.type === 'valid')) {
      assert.ok(c.expected.recipientName !== undefined, `Case ${c.id} missing recipientName`);
      assert.ok(c.expected.currency === 'USD', `Case ${c.id} expected currency must be USD`);
      assert.ok(Array.isArray(c.expected.items), `Case ${c.id} missing items array`);
      assert.ok(c.expected.items.length > 0, `Case ${c.id} has empty items`);
    }
  });

  it('rejection cases have a reason string', () => {
    for (const c of ALL_CASES.filter(c => c.expected.type === 'rejection')) {
      assert.ok(c.expected.reason && c.expected.reason.length > 0, `Case ${c.id} missing reason`);
    }
  });

  it('clarification cases have missingFields array', () => {
    for (const c of ALL_CASES.filter(c => c.expected.type === 'clarification')) {
      assert.ok(Array.isArray(c.expected.missingFields), `Case ${c.id} missing missingFields array`);
    }
  });

  it('no two cases share the same id', () => {
    const ids = ALL_CASES.map(c => c.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length);
  });

  it('all cases use the shared REFERENCE_DATE', () => {
    for (const c of ALL_CASES) {
      assert.equal(c.input.referenceDate, '2026-11-09', `Case ${c.id} uses wrong referenceDate`);
    }
  });
});
