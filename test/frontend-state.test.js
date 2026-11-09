'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../public/app');

describe('Frontend Form State & Stale Data Prevention', () => {
  let domElements;

  function createElement(tag, id = '') {
    const el = {
      tagName: tag,
      id,
      value: '',
      innerHTML: '',
      style: { display: 'none' },
      disabled: false,
      textContent: '',
      className: '',
      children: [],
      setAttribute(k, v) {
        this[k] = v;
      },
      appendChild(child) {
        this.children.push(child);
        if (child.id) {
          domElements[child.id] = child;
        }
      },
    };
    if (id) {
      domElements[id] = el;
    }
    return el;
  }

  beforeEach(() => {
    domElements = {};

    createElement('textarea', 'invoice-text');
    createElement('button', 'parseBtn');
    createElement('button', 'createDraftBtn');
    createElement('div', 'loading');
    createElement('div', 'message');
    createElement('section', 'invoice-form');
    createElement('section', 'confirm-section');
    createElement('input', 'recipientName');
    createElement('input', 'recipientEmail');
    createElement('input', 'currency');
    createElement('input', 'dueDate');
    createElement('div', 'items');

    global.document = {
      getElementById(id) {
        return domElements[id] || null;
      },
      createElement(tag) {
        const el = createElement(tag);
        // If an id is later assigned, allow lookup
        return new Proxy(el, {
          set(target, prop, val) {
            target[prop] = val;
            if (prop === 'id' && val) {
              domElements[val] = target;
            }
            return true;
          },
        });
      },
    };
  });

  it('clearInvoiceForm resets all fields, hides form, and disables confirmation', () => {
    // Populate with dummy state
    domElements.recipientName.value = 'Bob';
    domElements.recipientEmail.value = 'bob@example.com';
    domElements.currency.value = 'USD';
    domElements.dueDate.value = '2026-11-20';
    domElements.items.innerHTML = '<div>item 1</div>';
    domElements['invoice-form'].style.display = 'block';
    domElements['confirm-section'].style.display = 'block';
    domElements.createDraftBtn.disabled = false;

    app.clearInvoiceForm();

    assert.equal(domElements.recipientName.value, '');
    assert.equal(domElements.recipientEmail.value, '');
    assert.equal(domElements.currency.value, '');
    assert.equal(domElements.dueDate.value, '');
    assert.equal(domElements.items.innerHTML, '');
    assert.equal(domElements['invoice-form'].style.display, 'none');
    assert.equal(domElements['confirm-section'].style.display, 'none');
    assert.equal(domElements.createDraftBtn.disabled, true);
  });

  it('renderInvoiceForm renders valid invoice and enables confirm button', () => {
    const bobInvoice = {
      recipientName: 'Bob',
      recipientEmail: 'bob@example.com',
      currency: 'USD',
      dueDate: '2026-11-20',
      items: [{ description: 'Web Dev', quantity: 1, unitAmount: 500 }],
      missingFields: [],
      ambiguities: [],
    };

    app.renderInvoiceForm(bobInvoice);

    assert.equal(domElements.recipientName.value, 'Bob');
    assert.equal(domElements.recipientEmail.value, 'bob@example.com');
    assert.equal(domElements.currency.value, 'USD');
    assert.equal(domElements.dueDate.value, '2026-11-20');
    assert.equal(domElements.desc0.value, 'Web Dev');
    assert.equal(domElements['invoice-form'].style.display, 'block');
    assert.equal(domElements['confirm-section'].style.display, 'block');
    // For Bob with all fields present, createDraftBtn should be enabled
    assert.equal(domElements.createDraftBtn.disabled, false);
  });

  it('exact sequence: parse Bob, then parse Rahul without email clears Bob email and disables confirm', async () => {
    // 1. Parse Bob successfully
    const bobInvoice = {
      recipientName: 'Bob',
      recipientEmail: 'bob@example.com',
      currency: 'USD',
      dueDate: '2026-11-20',
      items: [{ description: 'Dev Work', quantity: 1, unitAmount: 400 }],
      missingFields: [],
      ambiguities: [],
    };

    app.renderInvoiceForm(bobInvoice);
    assert.equal(domElements.recipientName.value, 'Bob');
    assert.equal(domElements.recipientEmail.value, 'bob@example.com');
    assert.equal(domElements.createDraftBtn.disabled, false);

    // 2. Now user enters Rahul without an email
    domElements['invoice-text'].value = 'Invoice Rahul for $300 design, due tomorrow.';

    // Mock fetch to simulate /api/invoice/parse returning Rahul with null email and missingFields
    global.fetch = async (url) => {
      assert.equal(url, '/api/invoice/parse');
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: {
            recipientName: 'Rahul',
            recipientEmail: null,
            currency: 'USD',
            dueDate: '2026-11-15',
            items: [{ description: 'design', quantity: 1, unitAmount: 300 }],
            missingFields: ['recipientEmail'],
            ambiguities: [{ field: 'recipientEmail', question: 'What email address should receive this invoice?' }],
          },
        }),
      };
    };

    // Execute parseInvoice for Rahul
    await app.parseInvoice();

    // 3. Confirm Bob's email and all old fields are completely gone
    assert.equal(domElements.recipientName.value, 'Rahul');
    assert.equal(domElements.recipientEmail.value, '', "Bob's email must be gone and empty");
    assert.equal(domElements.dueDate.value, '2026-11-15');
    assert.equal(domElements.desc0.value, 'design', "Rahul's item must be present");

    // 4. Confirm creation is disabled because recipientEmail is missing
    assert.equal(domElements.createDraftBtn.disabled, true, 'Create Draft button must be disabled when email is missing');

    // 5. Confirm clarification guidance is displayed
    assert.ok(domElements.message.textContent.includes('recipientEmail'));
    assert.equal(domElements.message.className, 'warning');

    // 6. When user manually fills in Rahul's email, confirmation becomes enabled
    domElements.recipientEmail.value = 'rahul@example.com';
    app.updateConfirmButtonState();
    assert.equal(domElements.createDraftBtn.disabled, false, 'Button should enable once required email is supplied');
  });

  it('parse failure clears previous invoice details, disables creation, and shows only error', async () => {
    // 1. Initial successful draft (Bob)
    app.renderInvoiceForm({
      recipientName: 'Bob',
      recipientEmail: 'bob@example.com',
      currency: 'USD',
      dueDate: '2026-11-20',
      items: [{ description: 'Dev Work', quantity: 1, unitAmount: 400 }],
      missingFields: [],
      ambiguities: [],
    });
    assert.equal(domElements.recipientName.value, 'Bob');
    assert.equal(domElements['invoice-form'].style.display, 'block');

    // 2. Next parse fails with 400 error
    domElements['invoice-text'].value = 'invalid invoice with negative amounts -$50';
    global.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        errors: [{ path: 'items.unitAmount', field: 'unitAmount', message: 'Refunds or negative amounts are not supported' }],
      }),
    });

    await app.parseInvoice();

    // 3. Verify all details are cleared and creation disabled
    assert.equal(domElements.recipientName.value, '');
    assert.equal(domElements.recipientEmail.value, '');
    assert.equal(domElements.currency.value, '');
    assert.equal(domElements.dueDate.value, '');
    assert.equal(domElements.items.innerHTML, '');
    assert.equal(domElements['invoice-form'].style.display, 'none');
    assert.equal(domElements['confirm-section'].style.display, 'none');
    assert.equal(domElements.createDraftBtn.disabled, true);

    // 4. Verify only error is shown
    assert.equal(domElements.message.className, 'error');
    assert.ok(domElements.message.textContent.includes('Refunds or negative amounts are not supported'));
  });
});
