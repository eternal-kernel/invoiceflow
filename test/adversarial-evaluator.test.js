'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateAdversarialCase,
  runAdversarialEvaluation,
  buildAdversarialReport,
  formatAdversarialReport,
  detectTruncation,
  detectRounding,
  detectInvention,
  detectWrongCurrency,
  detectInjection,
  detectUnsupportedField,
} = require('../scripts/adversarial-evaluator');

const { ADVERSARIAL_CASES, REFERENCE_DATE } = require('./fixtures/adversarial-evaluation-cases');

function mockSuccess(data = {}) {
  return {
    success: true,
    data: {
      recipientName: 'Valid Name',
      recipientEmail: 'valid@example.com',
      currency: 'USD',
      dueDate: '2026-11-20',
      items: [{ description: 'consulting', quantity: 1, unitAmount: 100 }],
      missingFields: [],
      ambiguities: [],
      ...data,
    },
  };
}

function mockFailure(errors = [{ path: 'amount', message: 'Invalid amount' }]) {
  return {
    success: false,
    errors,
  };
}

describe('Adversarial fixture integrity', () => {
  it('contains exactly 30 cases', () => {
    assert.equal(ADVERSARIAL_CASES.length, 30);
  });

  it('all cases have unique IDs starting with A', () => {
    const ids = ADVERSARIAL_CASES.map((c) => c.id);
    const set = new Set(ids);
    assert.equal(set.size, ADVERSARIAL_CASES.length);
    for (const id of ids) {
      assert.match(id, /^A\d{2}$/);
    }
  });

  it('all cases specify a valid category and expected type', () => {
    for (const c of ADVERSARIAL_CASES) {
      assert.ok(c.category, `Case ${c.id} missing category`);
      assert.ok(['valid', 'clarification', 'rejection'].includes(c.expected.type));
    }
  });
});

describe('Safety invariant detection helpers', () => {
  it('detectTruncation flags 3 items when rejection was expected for truncation category', () => {
    const fakeCase = {
      category: 'truncation',
      expected: { type: 'rejection' },
    };
    const res = mockSuccess({
      items: [
        { description: '1', quantity: 1, unitAmount: 10 },
        { description: '2', quantity: 1, unitAmount: 10 },
        { description: '3', quantity: 1, unitAmount: 10 },
      ],
    });
    assert.equal(detectTruncation(fakeCase, res), true);
  });

  it('detectRounding flags success when precision rejection was expected', () => {
    const fakeCase = {
      category: 'precision',
      expected: { type: 'rejection' },
    };
    const res = mockSuccess();
    assert.equal(detectRounding(fakeCase, res), true);
  });

  it('detectInvention detects populated field that was expected to be missing', () => {
    const fakeCase = {
      expected: {
        type: 'clarification',
        missingFields: ['recipientEmail'],
      },
      invariants: ['INVENTION'],
    };
    const res = mockSuccess({ recipientEmail: 'invented@example.com' });
    assert.equal(detectInvention(fakeCase, res), true);
  });

  it('detectWrongCurrency flags non-USD success', () => {
    const fakeCase = {};
    const res = mockSuccess({ currency: 'EUR' });
    assert.equal(detectWrongCurrency(fakeCase, res), true);
  });

  it('detectInjection flags successful extraction when injection expected rejection', () => {
    const fakeCase = { invariants: ['INJECTION'] };
    const res = mockSuccess();
    assert.equal(detectInjection(fakeCase, res), true);
  });

  it('detectUnsupportedField flags extra disallowed terms in items or extra root keys', () => {
    const fakeCase = {};
    const res1 = mockSuccess({
      items: [{ description: 'sales tax', quantity: 1, unitAmount: 10 }],
    });
    assert.equal(detectUnsupportedField(fakeCase, res1), true);

    const res2 = mockSuccess({ taxAmount: 10 });
    assert.equal(detectUnsupportedField(fakeCase, res2), true);
  });
});

describe('evaluateAdversarialCase', () => {
  it('evaluates rejection case successfully when extractor fails', () => {
    const testCase = ADVERSARIAL_CASES.find((c) => c.expected.type === 'rejection');
    const result = evaluateAdversarialCase(testCase, mockFailure());
    assert.equal(result.pass, true);
    assert.equal(result.failureLayer, 'none');
  });

  it('evaluates rejection case as failed with layer when extractor incorrectly succeeds', () => {
    const testCase = ADVERSARIAL_CASES.find((c) => c.id === 'A01'); // precision rejection
    const result = evaluateAdversarialCase(testCase, mockSuccess());
    assert.equal(result.pass, false);
    assert.ok(result.violatedInvariants.includes('ROUNDING'));
    assert.equal(result.failureLayer, 'schema');
  });

  it('evaluates clarification case successfully when missingFields and ambiguities match', () => {
    const testCase = ADVERSARIAL_CASES.find((c) => c.id === 'A11'); // missing name & email
    const result = evaluateAdversarialCase(
      testCase,
      mockSuccess({
        recipientName: null,
        recipientEmail: null,
        missingFields: ['recipientName', 'recipientEmail'],
        ambiguities: [{ field: 'recipientEmail', question: 'What is recipient email?' }],
      })
    );
    assert.equal(result.pass, true);
    assert.equal(result.failureLayer, 'none');
  });

  it('evaluates valid case successfully when all fields and items match', () => {
    const testCase = ADVERSARIAL_CASES.find((c) => c.id === 'A03'); // valid $49.99
    const result = evaluateAdversarialCase(
      testCase,
      mockSuccess({
        recipientName: 'Faye',
        recipientEmail: 'faye@f.com',
        currency: 'USD',
        dueDate: '2026-11-25',
        items: [{ description: 'subscription setup', quantity: 1, unitAmount: 49.99 }],
      })
    );
    assert.equal(result.pass, true);
    assert.equal(result.failureLayer, 'none');
  });
});

describe('runAdversarialEvaluation and reporting', () => {
  it('runs deterministically across all cases without calling real APIs', async () => {
    const mockExtractor = async (text, opts) => {
      if (text.includes('49.99')) {
        return mockSuccess({
          recipientName: 'Faye',
          recipientEmail: 'faye@f.com',
          dueDate: '2026-11-25',
          items: [{ description: 'subscription setup', quantity: 1, unitAmount: 49.99 }],
        });
      }
      return mockFailure();
    };

    const report = await runAdversarialEvaluation(mockExtractor, ADVERSARIAL_CASES);
    assert.equal(report.cases.length, 30);
    assert.ok(report.summary.total === 30);
    assert.ok(typeof report.summary.passRate === 'number');

    const formatted = formatAdversarialReport(report);
    assert.ok(formatted.includes('Invoice Extraction Adversarial Evaluation Report'));
  });
});
