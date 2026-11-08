const test = require('node:test');
const assert = require('node:assert/strict');
const {
  invoiceItemSchema,
  invoiceDraftSchema,
  validatedInvoiceSchema,
  parseInvoiceDraft,
  parseValidatedInvoice,
} = require('../src/invoice/invoice-schema');

test('valid one-item invoice', () => {
  const invoice = {
    recipientName: 'Jane Doe',
    recipientEmail: 'jane@example.com',
    currency: 'USD',
    dueDate: '2026-12-01',
    items: [
      {
        description: 'Frontend Architecture Consulting',
        quantity: 5,
        unitAmount: 150.5,
      },
    ],
  };

  const validatedResult = parseValidatedInvoice(invoice);
  assert.equal(validatedResult.success, true);
  assert.equal(validatedResult.data.recipientName, 'Jane Doe');
  assert.equal(validatedResult.data.items.length, 1);
  assert.equal(validatedResult.data.items[0].unitAmount, 150.5);

  const draftResult = parseInvoiceDraft(invoice);
  assert.equal(draftResult.success, true);
  assert.deepEqual(draftResult.data.missingFields, []);
  assert.deepEqual(draftResult.data.ambiguities, []);
});

test('valid three-item invoice', () => {
  const invoice = {
    recipientName: 'Acme Corp',
    recipientEmail: 'billing@acme.com',
    currency: 'USD',
    dueDate: null,
    items: [
      { description: 'Design Review', quantity: 2, unitAmount: 75.0 },
      { description: 'Backend Integration', quantity: 10, unitAmount: 120.25 },
      { description: 'QA Testing', quantity: 4, unitAmount: 50.0 },
    ],
  };

  const result = parseValidatedInvoice(invoice);
  assert.equal(result.success, true);
  assert.equal(result.data.items.length, 3);
  assert.equal(result.data.dueDate, null);
});

test('missing recipient email in draft is allowed', () => {
  // Explicitly null
  const draftWithNullEmail = {
    recipientName: 'John Smith',
    recipientEmail: null,
    currency: 'USD',
    dueDate: null,
    items: [{ description: 'Strategy Session', quantity: 1, unitAmount: 200 }],
    missingFields: ['recipientEmail'],
  };

  const nullEmailResult = parseInvoiceDraft(draftWithNullEmail);
  assert.equal(nullEmailResult.success, true);
  assert.equal(nullEmailResult.data.recipientEmail, null);
  assert.deepEqual(nullEmailResult.data.missingFields, ['recipientEmail']);

  // Omitted email
  const draftWithOmittedEmail = {
    recipientName: 'John Smith',
    currency: 'USD',
    items: [{ description: 'Strategy Session', quantity: 1, unitAmount: 200 }],
  };

  const omittedEmailResult = parseInvoiceDraft(draftWithOmittedEmail);
  assert.equal(omittedEmailResult.success, true);
});

test('missing recipient email in validated invoice is rejected', () => {
  const invoiceNullEmail = {
    recipientName: 'John Smith',
    recipientEmail: null,
    currency: 'USD',
    items: [{ description: 'Strategy Session', quantity: 1, unitAmount: 200 }],
  };

  const nullEmailResult = parseValidatedInvoice(invoiceNullEmail);
  assert.equal(nullEmailResult.success, false);
  assert.ok(nullEmailResult.errors.some((e) => e.path.includes('recipientEmail')));

  const invoiceOmittedEmail = {
    recipientName: 'John Smith',
    currency: 'USD',
    items: [{ description: 'Strategy Session', quantity: 1, unitAmount: 200 }],
  };

  const omittedEmailResult = parseValidatedInvoice(invoiceOmittedEmail);
  assert.equal(omittedEmailResult.success, false);
  assert.ok(omittedEmailResult.errors.some((e) => e.path.includes('recipientEmail')));
});

test('unsupported currency is rejected', () => {
  const invalidCurrencyInvoice = {
    recipientName: 'International Client',
    recipientEmail: 'client@example.com',
    currency: 'EUR',
    items: [{ description: 'Translation', quantity: 1, unitAmount: 100 }],
  };

  const validatedResult = parseValidatedInvoice(invalidCurrencyInvoice);
  assert.equal(validatedResult.success, false);
  assert.ok(validatedResult.errors.some((e) => e.path.includes('currency')));

  const draftResult = parseInvoiceDraft(invalidCurrencyInvoice);
  assert.equal(draftResult.success, false);
  assert.ok(draftResult.errors.some((e) => e.path.includes('currency')));
});

test('zero and negative amounts are rejected', () => {
  const zeroAmountItem = {
    description: 'Free Gift',
    quantity: 1,
    unitAmount: 0,
  };
  const zeroResult = invoiceItemSchema.safeParse(zeroAmountItem);
  assert.equal(zeroResult.success, false);

  const negAmountItem = {
    description: 'Refund',
    quantity: 1,
    unitAmount: -50.0,
  };
  const negResult = invoiceItemSchema.safeParse(negAmountItem);
  assert.equal(negResult.success, false);

  // Exceeding 2 decimal places
  const threeDecimalsItem = {
    description: 'Fractional Cent',
    quantity: 1,
    unitAmount: 10.999,
  };
  const threeDecResult = invoiceItemSchema.safeParse(threeDecimalsItem);
  assert.equal(threeDecResult.success, false);
});

test('zero and negative quantities are rejected', () => {
  const zeroQuantityItem = {
    description: 'Service',
    quantity: 0,
    unitAmount: 100,
  };
  const zeroResult = invoiceItemSchema.safeParse(zeroQuantityItem);
  assert.equal(zeroResult.success, false);

  const negQuantityItem = {
    description: 'Service',
    quantity: -2,
    unitAmount: 100,
  };
  const negResult = invoiceItemSchema.safeParse(negQuantityItem);
  assert.equal(negResult.success, false);
});

test('four line items are rejected', () => {
  const fourItemsInvoice = {
    recipientName: 'Acme Corp',
    recipientEmail: 'billing@acme.com',
    currency: 'USD',
    items: [
      { description: 'Item 1', quantity: 1, unitAmount: 10 },
      { description: 'Item 2', quantity: 1, unitAmount: 20 },
      { description: 'Item 3', quantity: 1, unitAmount: 30 },
      { description: 'Item 4', quantity: 1, unitAmount: 40 },
    ],
  };

  const validatedResult = parseValidatedInvoice(fourItemsInvoice);
  assert.equal(validatedResult.success, false);
  assert.ok(validatedResult.errors.some((e) => e.path.includes('items')));

  const draftResult = parseInvoiceDraft(fourItemsInvoice);
  assert.equal(draftResult.success, false);
  assert.ok(draftResult.errors.some((e) => e.path.includes('items')));

  // Zero items are also rejected
  const zeroItemsInvoice = {
    recipientName: 'Acme Corp',
    recipientEmail: 'billing@acme.com',
    currency: 'USD',
    items: [],
  };
  assert.equal(parseValidatedInvoice(zeroItemsInvoice).success, false);
});

test('invalid email is rejected', () => {
  const invalidEmailInvoice = {
    recipientName: 'Bad Email User',
    recipientEmail: 'not-an-email',
    currency: 'USD',
    items: [{ description: 'Work', quantity: 1, unitAmount: 50 }],
  };

  const validatedResult = parseValidatedInvoice(invalidEmailInvoice);
  assert.equal(validatedResult.success, false);
  assert.ok(validatedResult.errors.some((e) => e.path.includes('recipientEmail')));

  const draftResult = parseInvoiceDraft(invalidEmailInvoice);
  assert.equal(draftResult.success, false);
  assert.ok(draftResult.errors.some((e) => e.path.includes('recipientEmail')));
});

test('invalid due-date format is rejected', () => {
  const invalidFormatDates = ['11-09-2026', '2026/11/09', '2026-02-31', 'not-a-date'];

  for (const badDate of invalidFormatDates) {
    const invoice = {
      recipientName: 'Test Recipient',
      recipientEmail: 'test@example.com',
      currency: 'USD',
      dueDate: badDate,
      items: [{ description: 'Work', quantity: 1, unitAmount: 100 }],
    };

    const validatedResult = parseValidatedInvoice(invoice);
    assert.equal(validatedResult.success, false, `Should reject bad dueDate: ${badDate}`);
    assert.ok(validatedResult.errors.some((e) => e.path.includes('dueDate')));

    const draftResult = parseInvoiceDraft(invoice);
    assert.equal(draftResult.success, false, `Should reject bad dueDate: ${badDate}`);
  }
});

test('tax and discount fields are rejected or not accepted by the schema', () => {
  // tax / discount on invoice item
  const itemWithTax = {
    description: 'Work',
    quantity: 1,
    unitAmount: 100,
    tax: 10,
  };
  assert.equal(invoiceItemSchema.safeParse(itemWithTax).success, false);

  const itemWithDiscount = {
    description: 'Work',
    quantity: 1,
    unitAmount: 100,
    discount: 5,
  };
  assert.equal(invoiceItemSchema.safeParse(itemWithDiscount).success, false);

  // tax / discount on root invoice
  const invoiceWithTax = {
    recipientName: 'Acme Corp',
    recipientEmail: 'billing@acme.com',
    currency: 'USD',
    tax: 15,
    items: [{ description: 'Work', quantity: 1, unitAmount: 100 }],
  };
  assert.equal(parseValidatedInvoice(invoiceWithTax).success, false);
  assert.equal(parseInvoiceDraft(invoiceWithTax).success, false);

  const invoiceWithDiscount = {
    recipientName: 'Acme Corp',
    recipientEmail: 'billing@acme.com',
    currency: 'USD',
    discount: 10,
    items: [{ description: 'Work', quantity: 1, unitAmount: 100 }],
  };
  assert.equal(parseValidatedInvoice(invoiceWithDiscount).success, false);
  assert.equal(parseInvoiceDraft(invoiceWithDiscount).success, false);
});

test('malformed input is handled without crashing', () => {
  const malformedInputs = [null, undefined, '', 123, true, [], { items: 'not-an-array' }, { items: [null] }];

  for (const badInput of malformedInputs) {
    const validatedResult = parseValidatedInvoice(badInput);
    assert.equal(validatedResult.success, false);
    assert.ok(Array.isArray(validatedResult.errors));
    assert.ok(validatedResult.errors.length > 0);

    const draftResult = parseInvoiceDraft(badInput);
    assert.equal(draftResult.success, false);
    assert.ok(Array.isArray(draftResult.errors));
    assert.ok(draftResult.errors.length > 0);
  }
});
