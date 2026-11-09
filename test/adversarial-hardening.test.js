'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractInvoiceDraft } = require('../src/ai/invoice-extractor');
const { evaluateAdversarialCase } = require('../scripts/adversarial-evaluator');
const { ADVERSARIAL_CASES } = require('./fixtures/adversarial-evaluation-cases');

describe('Adversarial Safety Hardening Regressions', () => {
  it('A01/A02: Rejects explicit monetary values with >2 decimal places', async () => {
    const res1 = await extractInvoiceDraft('Invoice Dana (dana@dana.com) for $99.999 analytics. Due 2026-11-20.');
    assert.equal(res1.success, false);
    assert.ok(res1.errors.some(e => e.message.includes('more than 2 decimal places')));

    const res2 = await extractInvoiceDraft('Invoice Eli (eli@e.com) $100 split equally among 3 items (each $33.333). Due 2026-11-20.');
    assert.equal(res2.success, false);
  });

  it('A04/A05: Rejects explicit requests with >3 line items', async () => {
    const res1 = await extractInvoiceDraft('Invoice Greg (greg@g.com): $100 research, $200 writing, $150 design, $50 review. Due 2026-11-28.');
    assert.equal(res1.success, false);
    assert.ok(res1.errors.some(e => e.message.includes('cannot exceed 3 line items')));

    const res2 = await extractInvoiceDraft('Invoice Hana (hana@h.com): $50 planning, $100 design, $200 dev, $75 QA, $25 deploy, $30 docs. Due 2026-12-01.');
    assert.equal(res2.success, false);
  });

  it('A10: Rejects invalid explicit calendar dates like 2026-13-45', async () => {
    const res = await extractInvoiceDraft('Invoice Mia (mia@m.com) for $250 illustration. Due 2026-13-45.');
    assert.equal(res.success, false);
    assert.ok(res.errors.some(e => e.message.includes('not a valid calendar date')));
  });

  it('A13: Rejects malformed explicit email missing @', async () => {
    const res = await extractInvoiceDraft('Invoice Omar at omarexample.com for $700 consulting. Due 2026-11-20.');
    assert.equal(res.success, false);
    assert.ok(res.errors.some(e => e.message.includes('malformed')));
  });

  it('A19: Rejects explicit refund / negative credit deduction requests', async () => {
    const res = await extractInvoiceDraft('Invoice Uma (uma@u.com) for $500 consulting minus $200 refund for cancellation. Due 2026-11-28.');
    assert.equal(res.success, false);
    assert.ok(res.errors.some(e => e.message.includes('Refunds, credits, or negative amounts are not supported')));
  });

  it('A28: Rejects empty item description', async () => {
    const res = await extractInvoiceDraft('Invoice Carl (carl@c.com) for $200 for "". Due 2026-11-20.');
    assert.equal(res.success, false);
    assert.ok(res.errors.some(e => e.message.includes('Item description cannot be empty')));
  });
});

describe('False-Positive Prevention Regressions', () => {
  it('does NOT reject invoices containing totals and subtotals with 3 or fewer items', async () => {
    // 3 items with a total mentioned
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                recipientName: 'Carol',
                recipientEmail: 'carol@c.com',
                currency: 'USD',
                dueDate: '2026-11-20',
                items: [
                  { description: 'design', quantity: 1, unitAmount: 100 },
                  { description: 'dev', quantity: 1, unitAmount: 200 },
                  { description: 'setup', quantity: 1, unitAmount: 50 },
                ],
                missingFields: [],
                ambiguities: [],
              }),
            }],
          },
        }],
      }),
    });

    const res = await extractInvoiceDraft(
      'Invoice Carol (carol@c.com): $100 design, $200 dev, and $50 setup, total $350. Due 2026-11-20.',
      { fetch: mockFetch, apiKey: 'test-key' }
    );
    assert.equal(res.success, true);
    assert.equal(res.data.items.length, 3);
  });

  it('does NOT reject valid domains after "to" or "at"', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                recipientName: 'Acme.co',
                recipientEmail: null,
                currency: 'USD',
                dueDate: '2026-11-20',
                items: [{ description: 'consulting', quantity: 1, unitAmount: 500 }],
                missingFields: ['recipientEmail'],
                ambiguities: [{ field: 'recipientEmail', question: 'What is the email?' }],
              }),
            }],
          },
        }],
      }),
    });

    const res1 = await extractInvoiceDraft('Send invoice to Acme.co for $500 consulting. Due 2026-11-20.', { fetch: mockFetch, apiKey: 'test-key' });
    assert.equal(res1.success, true);

    const res2 = await extractInvoiceDraft('Invoice Alice at dev.io for $300 work. Due 2026-11-20.', { fetch: mockFetch, apiKey: 'test-key' });
    assert.equal(res2.success, true);
  });

  it('does NOT reject version numbers and IP-like decimals without $', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                recipientName: 'Alice',
                recipientEmail: 'alice@example.com',
                currency: 'USD',
                dueDate: '2026-11-20',
                items: [{ description: 'consulting on v2.1001', quantity: 1, unitAmount: 100 }],
                missingFields: [],
                ambiguities: [],
              }),
            }],
          },
        }],
      }),
    });

    const res = await extractInvoiceDraft(
      'Invoice Alice (alice@example.com) for $100 consulting on spec v2.1001 and IP 192.168.100.1. Due 2026-11-20.',
      { fetch: mockFetch, apiKey: 'test-key' }
    );
    assert.equal(res.success, true);
  });

  it('post-validation detects past due dates and returns explicit clarification result without silent mutation', async () => {
    // Model returns yesterday's date
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                recipientName: 'Kim',
                recipientEmail: 'kim@k.com',
                currency: 'USD',
                dueDate: '2026-11-08', // yesterday relative to 2026-11-09
                items: [{ description: 'copywriting', quantity: 1, unitAmount: 300 }],
                missingFields: [],
                ambiguities: [],
              }),
            }],
          },
        }],
      }),
    });

    const res = await extractInvoiceDraft(
      'Invoice Kim (kim@k.com) for $300 copywriting, due yesterday.',
      { fetch: mockFetch, apiKey: 'test-key', referenceDate: '2026-11-09' }
    );

    assert.equal(res.success, true);
    // Must NOT silently mutate the date to today or a future date: dueDate must be null
    assert.equal(res.data.dueDate, null);
    // Must explicitly include dueDate in missingFields
    assert.ok(res.data.missingFields.includes('dueDate'));
    // Must explicitly include clarification in ambiguities
    assert.ok(res.data.ambiguities.some(a => a.field === 'dueDate' && a.question.includes('prior to the reference date')));
  });
});

describe('Evaluator-Only Expectation Regressions (A06, A24, A26)', () => {
  it('A06: Evaluator accepts a correctly worded clarification about pricing conflict', () => {
    const caseA06 = ADVERSARIAL_CASES.find(c => c.id === 'A06');
    const mockResult = {
      success: true,
      data: {
        recipientName: 'Iris',
        recipientEmail: 'iris@i.com',
        currency: 'USD',
        dueDate: '2026-11-20',
        items: [{ description: 'workshops', quantity: 5, unitAmount: 100 }],
        missingFields: [],
        ambiguities: [{
          field: 'total',
          question: 'The provided total of $600 does not match the calculated subtotal of $500 (5 * $100). Please clarify if there are additional fees or if the unit price/quantity is different.',
        }],
      },
    };

    const evaluation = evaluateAdversarialCase(caseA06, mockResult);
    assert.equal(evaluation.pass, true);
    assert.equal(evaluation.failureLayer, 'none');
  });

  it('A24: Evaluator accepts original multilingual description without requiring translation', () => {
    const caseA24 = ADVERSARIAL_CASES.find(c => c.id === 'A24');
    const mockResult = {
      success: true,
      data: {
        recipientName: 'Wei Zhang',
        recipientEmail: 'wei@zh.com',
        currency: 'USD',
        dueDate: '2026-11-28',
        items: [{ description: 'تصميم جرافيك 图形设计', quantity: 1, unitAmount: 750 }],
        missingFields: [],
        ambiguities: [],
      },
    };

    const evaluation = evaluateAdversarialCase(caseA24, mockResult);
    assert.equal(evaluation.pass, true);
    assert.equal(evaluation.failureLayer, 'none');
  });

  it('A26: Evaluator accepts safe rejection for unsupported BTC currency', () => {
    const caseA26 = ADVERSARIAL_CASES.find(c => c.id === 'A26');
    const mockResult = {
      success: false,
      errors: [{ path: 'currency', field: 'currency', message: 'Currency must be USD' }],
    };

    const evaluation = evaluateAdversarialCase(caseA26, mockResult);
    assert.equal(evaluation.pass, true);
    assert.equal(evaluation.failureLayer, 'none');
  });
});
