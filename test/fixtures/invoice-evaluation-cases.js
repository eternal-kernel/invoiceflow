'use strict';
/**
 * Invoice extraction evaluation cases.
 *
 * IMPORTANT: These cases were authored by the InvoiceFlow development team
 * and are NOT an independent benchmark. They serve as a structured
 * regression suite to track extraction quality over time.
 *
 * Cases 1–20  → development / tuning set (may be used to adjust prompts).
 * Cases 21–30 → held-out set (must NOT be used to adjust prompts).
 *
 * Expected outcome types:
 *   'valid'         – extraction must succeed; exact field values are checked.
 *   'clarification' – extraction succeeds but specific fields must be in
 *                     missingFields and/or ambiguities (intentionally ambiguous).
 *   'rejection'     – extraction must fail (success: false); a reason is noted.
 *
 * All cases use referenceDate "2026-11-09" (a Monday) so relative-date
 * resolution is deterministic.
 */

const REFERENCE_DATE = '2026-11-09';

/** @type {EvalCase[]} */
const DEV_CASES = [
  // ── 1. Normal one-item invoice, all fields explicit ────────────────────────
  {
    id: 1,
    set: 'dev',
    description: 'Normal one-item invoice with all fields supplied explicitly',
    input: {
      text: 'Invoice Alice Smith at alice@example.com for $150 web design. Due 2026-11-16.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Alice Smith',
      recipientEmail: 'alice@example.com',
      currency: 'USD',
      dueDate: '2026-11-16',
      items: [{ description: 'web design', quantity: 1, unitAmount: 150 }],
    },
  },

  // ── 2. Two-item invoice ────────────────────────────────────────────────────
  {
    id: 2,
    set: 'dev',
    description: 'Two-item invoice with explicit amounts and due date',
    input: {
      text: 'Please create an invoice for Bob Jones (bob@jones.io): $500 logo design and $250 brand guidelines. Due 2026-11-30.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Bob Jones',
      recipientEmail: 'bob@jones.io',
      currency: 'USD',
      dueDate: '2026-11-30',
      items: [
        { description: 'logo design', quantity: 1, unitAmount: 500 },
        { description: 'brand guidelines', quantity: 1, unitAmount: 250 },
      ],
    },
  },

  // ── 3. Three-item invoice ──────────────────────────────────────────────────
  {
    id: 3,
    set: 'dev',
    description: 'Three-item invoice at the maximum allowed number of items',
    input: {
      text: 'Invoice Carol (carol@co.com): $200 copywriting, $100 editing, $50 proofreading. Due 2026-12-01.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Carol',
      recipientEmail: 'carol@co.com',
      currency: 'USD',
      dueDate: '2026-12-01',
      items: [
        { description: 'copywriting', quantity: 1, unitAmount: 200 },
        { description: 'editing', quantity: 1, unitAmount: 100 },
        { description: 'proofreading', quantity: 1, unitAmount: 50 },
      ],
    },
  },

  // ── 4. Relative date "in 7 days" ──────────────────────────────────────────
  {
    id: 4,
    set: 'dev',
    description: 'Relative due date expressed as "in 7 days"',
    input: {
      text: 'Invoice Dan at dan@dan.com for $75 consulting. Due in 7 days.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Dan',
      recipientEmail: 'dan@dan.com',
      currency: 'USD',
      dueDate: '2026-11-16',
      items: [{ description: 'consulting', quantity: 1, unitAmount: 75 }],
    },
  },

  // ── 5. Relative date "next Friday" ────────────────────────────────────────
  {
    id: 5,
    set: 'dev',
    description: 'Relative due date expressed as "next Friday" (from Monday 2026-11-09)',
    input: {
      text: 'Send invoice to Eva (eva@eva.com) for $300 UI design, due next Friday.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Eva',
      recipientEmail: 'eva@eva.com',
      currency: 'USD',
      dueDate: '2026-11-13',
      items: [{ description: 'UI design', quantity: 1, unitAmount: 300 }],
    },
  },

  // ── 6. Missing email – must flag as clarification ─────────────────────────
  {
    id: 6,
    set: 'dev',
    description: 'Missing recipient email should appear in missingFields and ambiguities',
    input: {
      text: 'Invoice Frank Miller for $400 photography. Due 2026-11-20.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: ['recipientEmail'],
      clarificationField: 'recipientEmail',
    },
  },

  // ── 7. Missing recipient name ─────────────────────────────────────────────
  {
    id: 7,
    set: 'dev',
    description: 'Missing recipient name should appear in missingFields',
    input: {
      text: 'Invoice someone at unknown@example.com for $120 video editing. Due 2026-11-25.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: ['recipientName'],
      clarificationField: 'recipientName',
    },
  },

  // ── 8. Messy wording / informal style ────────────────────────────────────
  {
    id: 8,
    set: 'dev',
    description: 'Informal, messy phrasing with all required information present',
    input: {
      text: 'hey can u invoice gina at gina@werk.com 250 bucks for the website thing we did. due in 2 weeks.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Gina',
      recipientEmail: 'gina@werk.com',
      currency: 'USD',
      dueDate: '2026-11-23',
      items: [{ description: 'website', quantity: 1, unitAmount: 250 }],
    },
  },

  // ── 9. Decimal unit amounts ───────────────────────────────────────────────
  {
    id: 9,
    set: 'dev',
    description: 'Unit amounts with up to two decimal places',
    input: {
      text: 'Invoice Hana (hana@co.com) for 3 hours of consulting at $99.99 per hour. Due 2026-11-18.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Hana',
      recipientEmail: 'hana@co.com',
      currency: 'USD',
      dueDate: '2026-11-18',
      items: [{ description: 'consulting', quantity: 3, unitAmount: 99.99 }],
    },
  },

  // ── 10. Unsupported currency (EUR) → rejection ────────────────────────────
  {
    id: 10,
    set: 'dev',
    description: 'Non-USD currency (EUR) should cause rejection by schema validation',
    input: {
      text: 'Invoice Ivan (ivan@co.com) for €500 translation work. Due 2026-11-28.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'Only USD is supported; EUR should fail schema validation',
    },
  },

  // ── 11. Tax request – must NOT be included, should be noted in ambiguities ─
  {
    id: 11,
    set: 'dev',
    description: 'Tax request must be omitted from items and mentioned in ambiguities',
    input: {
      text: 'Invoice Jane (jane@j.com) $1000 for development + 10% tax. Due 2026-11-30.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: [],
      clarificationField: null, // ambiguity expected about tax, not a missingField
      ambiguityAbout: 'tax',
    },
  },

  // ── 12. Discount request – must NOT be included ───────────────────────────
  {
    id: 12,
    set: 'dev',
    description: 'Discount request must be excluded; ambiguity expected',
    input: {
      text: 'Invoice Kyle (kyle@k.com) $800 for SEO, minus 20% loyalty discount. Due 2026-12-05.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: [],
      clarificationField: null,
      ambiguityAbout: 'discount',
    },
  },

  // ── 13. Zero amount → rejection ───────────────────────────────────────────
  {
    id: 13,
    set: 'dev',
    description: 'Zero unit amount should be rejected by schema validation',
    input: {
      text: 'Invoice Laura (laura@l.com) for $0 initial consultation. Due 2026-11-20.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'Zero amounts are invalid; schema requires positive unitAmount',
    },
  },

  // ── 14. Intentionally ambiguous date ("ASAP") ─────────────────────────────
  {
    id: 14,
    set: 'dev',
    description: 'Ambiguous due date ("ASAP") must set dueDate=null and flag in ambiguities',
    input: {
      text: 'Invoice Mark (mark@m.com) for $600 marketing copy ASAP.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: ['dueDate'],
      clarificationField: 'dueDate',
    },
  },

  // ── 15. Missing amount → rejection ────────────────────────────────────────
  {
    id: 15,
    set: 'dev',
    description: 'Missing amount should cause the item to be invalid or rejected',
    input: {
      text: 'Invoice Nina (nina@n.com) for some design work. Due 2026-11-20.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'No amount provided; item unitAmount cannot be determined',
    },
  },

  // ── 16. Quantity > 1 explicit ─────────────────────────────────────────────
  {
    id: 16,
    set: 'dev',
    description: 'Multi-unit item with explicit quantity',
    input: {
      text: 'Invoice Omar (omar@o.com) for 5 training sessions at $200 each. Due 2026-12-01.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Omar',
      recipientEmail: 'omar@o.com',
      currency: 'USD',
      dueDate: '2026-12-01',
      items: [{ description: 'training sessions', quantity: 5, unitAmount: 200 }],
    },
  },

  // ── 17. Relative date "end of the month" ─────────────────────────────────
  {
    id: 17,
    set: 'dev',
    description: 'Relative due date "end of the month" (from 2026-11-09 → 2026-11-30)',
    input: {
      text: 'Invoice Paula (paula@p.com) $450 for content writing, due end of the month.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Paula',
      recipientEmail: 'paula@p.com',
      currency: 'USD',
      dueDate: '2026-11-30',
      items: [{ description: 'content writing', quantity: 1, unitAmount: 450 }],
    },
  },

  // ── 18. Mixed casing in email ─────────────────────────────────────────────
  {
    id: 18,
    set: 'dev',
    description: 'Email address with mixed casing should be accepted',
    input: {
      text: 'Invoice Quinn (Quinn.B@Agency.COM) for $175 illustration. Due 2026-11-22.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Quinn',
      recipientEmail: 'Quinn.B@Agency.COM',
      currency: 'USD',
      dueDate: '2026-11-22',
      items: [{ description: 'illustration', quantity: 1, unitAmount: 175 }],
    },
  },

  // ── 19. Amount with comma separator ($1,500) ──────────────────────────────
  {
    id: 19,
    set: 'dev',
    description: 'Dollar amount formatted with comma thousands separator',
    input: {
      text: 'Invoice Rachel (rachel@r.com) for $1,500 website redesign. Due 2026-12-10.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Rachel',
      recipientEmail: 'rachel@r.com',
      currency: 'USD',
      dueDate: '2026-12-10',
      items: [{ description: 'website redesign', quantity: 1, unitAmount: 1500 }],
    },
  },

  // ── 20. Four line items → rejection (max 3 allowed) ───────────────────────
  {
    id: 20,
    set: 'dev',
    description: 'Four line items exceed the maximum of 3 and must be rejected',
    input: {
      text: 'Invoice Sam (sam@s.com) for $100 design, $200 dev, $50 testing, $75 deployment. Due 2026-11-28.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'Four items exceed the 3-item maximum; schema validation should fail',
    },
  },
];

/** @type {EvalCase[]} */
const HELD_OUT_CASES = [
  // ── 21. Terse one-liner with all details ──────────────────────────────────
  {
    id: 21,
    set: 'held-out',
    description: 'Very terse one-liner with all required fields present',
    input: {
      text: 'Invoice tom@tom.com Tom Lee $500 consulting 2026-11-20.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Tom Lee',
      recipientEmail: 'tom@tom.com',
      currency: 'USD',
      dueDate: '2026-11-20',
      items: [{ description: 'consulting', quantity: 1, unitAmount: 500 }],
    },
  },

  // ── 22. Missing both email and due date ───────────────────────────────────
  {
    id: 22,
    set: 'held-out',
    description: 'Both email and due date absent; both must appear in missingFields',
    input: {
      text: 'Invoice Uma for $350 photography work.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: ['recipientEmail', 'dueDate'],
      clarificationField: 'recipientEmail',
    },
  },

  // ── 23. Three items with varied quantities ────────────────────────────────
  {
    id: 23,
    set: 'held-out',
    description: 'Three items, each with a different quantity greater than 1',
    input: {
      text: 'Invoice Victor (victor@v.com): 2 workshops at $300 each, 4 consulting hours at $150 each, 1 report for $200. Due 2026-12-05.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Victor',
      recipientEmail: 'victor@v.com',
      currency: 'USD',
      dueDate: '2026-12-05',
      items: [
        { description: 'workshops', quantity: 2, unitAmount: 300 },
        { description: 'consulting hours', quantity: 4, unitAmount: 150 },
        { description: 'report', quantity: 1, unitAmount: 200 },
      ],
    },
  },

  // ── 24. Unsupported currency (GBP) → rejection ───────────────────────────
  {
    id: 24,
    set: 'held-out',
    description: 'Non-USD currency (GBP) should be rejected by schema validation',
    input: {
      text: 'Invoice Wendy (wendy@w.com) for £750 branding. Due 2026-11-25.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'Only USD is supported; GBP should fail schema validation',
    },
  },

  // ── 25. Negative amount → rejection ──────────────────────────────────────
  {
    id: 25,
    set: 'held-out',
    description: 'Negative unit amount must be rejected',
    input: {
      text: 'Invoice Xavier (x@x.com) for -$200 refund on consulting. Due 2026-11-20.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'Negative amounts are invalid; schema requires positive unitAmount',
    },
  },

  // ── 26. Relative date "in 30 days" ───────────────────────────────────────
  {
    id: 26,
    set: 'held-out',
    description: 'Relative due date "in 30 days" from 2026-11-09 → 2026-12-09',
    input: {
      text: 'Invoice Yara (yara@y.com) for $900 development work, due in 30 days.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Yara',
      recipientEmail: 'yara@y.com',
      currency: 'USD',
      dueDate: '2026-12-09',
      items: [{ description: 'development work', quantity: 1, unitAmount: 900 }],
    },
  },

  // ── 27. No recipient name, email present ──────────────────────────────────
  {
    id: 27,
    set: 'held-out',
    description: 'Recipient name absent; must appear in missingFields',
    input: {
      text: 'Invoice z@z.com for $250 animation. Due 2026-11-28.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: ['recipientName'],
      clarificationField: 'recipientName',
    },
  },

  // ── 28. Intentionally vague date ("sometime next month") ─────────────────
  {
    id: 28,
    set: 'held-out',
    description: 'Vague date "sometime next month" is intentionally ambiguous; dueDate must be null',
    input: {
      text: 'Invoice Ash (ash@a.com) for $600 UX research, due sometime next month.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'clarification',
      missingFields: ['dueDate'],
      clarificationField: 'dueDate',
    },
  },

  // ── 29. Amount with more than 2 decimal places → rejection ───────────────
  {
    id: 29,
    set: 'held-out',
    description: 'Unit amount with 3 decimal places must be rejected by schema validation',
    input: {
      text: 'Invoice Brook (brook@b.com) for $99.999 analytics. Due 2026-11-20.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'rejection',
      reason: 'unitAmount with more than 2 decimal places must be rejected',
    },
  },

  // ── 30. Normal complete invoice – held-out smoke test ────────────────────
  {
    id: 30,
    set: 'held-out',
    description: 'Complete, well-formed invoice request with no ambiguity',
    input: {
      text: 'Please invoice Chris Green at chris@green.io for $1200 website development. Due 2026-12-15.',
      referenceDate: REFERENCE_DATE,
    },
    expected: {
      type: 'valid',
      recipientName: 'Chris Green',
      recipientEmail: 'chris@green.io',
      currency: 'USD',
      dueDate: '2026-12-15',
      items: [{ description: 'website development', quantity: 1, unitAmount: 1200 }],
    },
  },
];

/** All 30 cases in order. */
const ALL_CASES = [...DEV_CASES, ...HELD_OUT_CASES];

module.exports = { ALL_CASES, DEV_CASES, HELD_OUT_CASES, REFERENCE_DATE };
