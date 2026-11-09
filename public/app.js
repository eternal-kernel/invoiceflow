// Minimal client-side script for InvoiceFlow UI
// Handles parse and draft creation via the backend API.

function clearInvoiceForm() {
  const nameEl = document.getElementById('recipientName');
  const emailEl = document.getElementById('recipientEmail');
  const currEl = document.getElementById('currency');
  const dueEl = document.getElementById('dueDate');
  const itemsContainer = document.getElementById('items');
  const form = document.getElementById('invoice-form');
  const confirmSection = document.getElementById('confirm-section');
  const createDraftBtn = document.getElementById('createDraftBtn');

  if (nameEl) nameEl.value = '';
  if (emailEl) emailEl.value = '';
  if (currEl) currEl.value = '';
  if (dueEl) dueEl.value = '';
  if (itemsContainer) itemsContainer.innerHTML = '';
  if (form) form.style.display = 'none';
  if (confirmSection) confirmSection.style.display = 'none';
  if (createDraftBtn) createDraftBtn.disabled = true;
}

function setLoading(isLoading) {
  const el = document.getElementById('loading');
  if (el) el.style.display = isLoading ? 'block' : 'none';
}

function showMessage(msg, type) {
  const el = document.getElementById('message');
  if (!el) return;
  el.textContent = msg || '';
  el.className = type || '';
}

function updateConfirmButtonState() {
  const confirmSection = document.getElementById('confirm-section');
  const createDraftBtn = document.getElementById('createDraftBtn');
  if (!confirmSection || !createDraftBtn) return;

  const recipientName = (document.getElementById('recipientName')?.value || '').trim();
  const recipientEmail = (document.getElementById('recipientEmail')?.value || '').trim();
  const currency = (document.getElementById('currency')?.value || '').trim();
  const dueDate = (document.getElementById('dueDate')?.value || '').trim();

  // Basic email syntax validation
  const validEmail = recipientEmail.includes('@') && /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(recipientEmail);

  let hasValidItem = false;
  for (let i = 0; i < 3; i++) {
    const desc = document.getElementById(`desc${i}`);
    const qty = document.getElementById(`qty${i}`);
    const unit = document.getElementById(`unit${i}`);
    if (desc && qty && unit && desc.value.trim()) {
      const q = parseInt(qty.value, 10);
      const u = parseFloat(unit.value);
      if (!isNaN(q) && q > 0 && !isNaN(u) && u > 0) {
        hasValidItem = true;
      }
    }
  }

  const isValid = Boolean(recipientName && validEmail && currency && dueDate && hasValidItem);
  createDraftBtn.disabled = !isValid;
}

function renderInvoiceForm(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    clearInvoiceForm();
    showMessage('Invalid parse response received.', 'error');
    return;
  }

  // Atomically set all fields; if null/undefined, set to empty string (never retain previous values)
  const nameEl = document.getElementById('recipientName');
  const emailEl = document.getElementById('recipientEmail');
  const currEl = document.getElementById('currency');
  const dueEl = document.getElementById('dueDate');
  const itemsContainer = document.getElementById('items');
  const form = document.getElementById('invoice-form');
  const confirmSection = document.getElementById('confirm-section');

  if (nameEl) nameEl.value = parsed.recipientName || '';
  if (emailEl) emailEl.value = parsed.recipientEmail || '';
  if (currEl) currEl.value = parsed.currency || '';
  if (dueEl) dueEl.value = parsed.dueDate || '';

  // Render items (limited to 3)
  if (itemsContainer) {
    itemsContainer.innerHTML = '';
    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, 3) : [];
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'item-row';

      const descInput = document.createElement('input');
      descInput.type = 'text';
      descInput.placeholder = 'Description';
      descInput.id = `desc${idx}`;
      descInput.value = it.description || '';
      descInput.setAttribute('autocomplete', 'off');

      const qtyInput = document.createElement('input');
      qtyInput.type = 'number';
      qtyInput.placeholder = 'Qty';
      qtyInput.id = `qty${idx}`;
      qtyInput.value = it.quantity != null ? String(it.quantity) : '';
      qtyInput.min = '1';
      qtyInput.setAttribute('autocomplete', 'off');

      const unitInput = document.createElement('input');
      unitInput.type = 'number';
      unitInput.placeholder = 'Unit Amount';
      unitInput.id = `unit${idx}`;
      unitInput.value = it.unitAmount != null ? String(it.unitAmount) : '';
      unitInput.step = '0.01';
      unitInput.min = '0';
      unitInput.setAttribute('autocomplete', 'off');

      row.appendChild(descInput);
      row.appendChild(qtyInput);
      row.appendChild(unitInput);
      itemsContainer.appendChild(row);
    });
  }

  // Display form and confirm section
  if (form) form.style.display = 'block';
  if (confirmSection) confirmSection.style.display = 'block';

  // Handle missing fields and ambiguities (clarification guidance)
  const missing = Array.isArray(parsed.missingFields) ? parsed.missingFields : [];
  const ambiguities = Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [];

  if (missing.length > 0 || ambiguities.length > 0) {
    const guidanceParts = [];
    if (missing.length > 0) {
      guidanceParts.push('Missing required fields: ' + missing.join(', ') + '. Please fill them in.');
    }
    ambiguities.forEach((a) => {
      if (a.question) guidanceParts.push(a.question);
    });
    showMessage(guidanceParts.join(' | '), 'warning');
  } else {
    showMessage('', '');
  }

  // Update confirmation button enabled/disabled state
  updateConfirmButtonState();
}

async function parseInvoice() {
  const text = document.getElementById('invoice-text')?.value.trim() || '';
  if (!text) {
    clearInvoiceForm();
    showMessage('Please enter invoice text.', 'error');
    return;
  }

  // Clear previous draft details atomically before parsing new input
  clearInvoiceForm();
  showMessage('', '');
  setLoading(true);

  try {
    const res = await fetch('/api/invoice/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      clearInvoiceForm();
      const errorMsg = (data.errors && data.errors.map((e) => e.message).join('; ')) || 'Unknown parse error';
      showMessage('Parse error: ' + errorMsg, 'error');
      return;
    }
    renderInvoiceForm(data.data);
  } catch (e) {
    clearInvoiceForm();
    showMessage('Network error while parsing: ' + (e.message || 'Connection failed'), 'error');
  } finally {
    setLoading(false);
  }
}

function collectInvoiceFromForm() {
  const recipientName = (document.getElementById('recipientName')?.value || '').trim();
  const recipientEmail = (document.getElementById('recipientEmail')?.value || '').trim();
  const currency = (document.getElementById('currency')?.value || '').trim();
  const dueDate = (document.getElementById('dueDate')?.value || '').trim();

  if (!recipientName || !recipientEmail || !currency || !dueDate) {
    showMessage('All main fields are required.', 'error');
    return null;
  }

  const items = [];
  for (let i = 0; i < 3; i++) {
    const desc = document.getElementById(`desc${i}`);
    const qty = document.getElementById(`qty${i}`);
    const unit = document.getElementById(`unit${i}`);
    if (desc && qty && unit && desc.value.trim()) {
      const quantity = parseInt(qty.value, 10);
      const unitAmount = parseFloat(unit.value);
      if (isNaN(quantity) || quantity <= 0 || isNaN(unitAmount) || unitAmount <= 0) {
        showMessage('Invalid item quantity or unit amount.', 'error');
        return null;
      }
      items.push({ description: desc.value.trim(), quantity, unitAmount });
    }
  }

  if (items.length === 0) {
    showMessage('At least one item is required.', 'error');
    return null;
  }

  return { recipientName, recipientEmail, currency, dueDate, items };
}

async function submitDraft() {
  const confirmed = true;
  const invoice = collectInvoiceFromForm();
  if (!invoice) return; // validation errors already shown

  setLoading(true);
  try {
    const res = await fetch('/api/invoice/create-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed, invoice }),
    });
    const data = await res.json();
    if (!res.ok) {
      const errorMsg = (data.errors && data.errors.map((e) => e.message).join('; ')) || 'Unknown error';
      showMessage('Draft creation error: ' + errorMsg, 'error');
      return;
    }
    showMessage('Draft created successfully! ID: ' + data.data.id + ' (Status: ' + data.data.status + ')', 'success');
  } catch (e) {
    showMessage('Network error while creating draft: ' + (e.message || 'Connection failed'), 'error');
  } finally {
    setLoading(false);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]+/g, function (s) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    }[s] || s;
  });
}

// Attach event listeners after DOM load.
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const parseBtn = document.getElementById('parseBtn');
    if (parseBtn) parseBtn.addEventListener('click', parseInvoice);

    const createDraftBtn = document.getElementById('createDraftBtn');
    if (createDraftBtn) createDraftBtn.addEventListener('click', submitDraft);

    const form = document.getElementById('invoice-form');
    if (form) form.addEventListener('input', updateConfirmButtonState);
  });
}

// Export functions for testing if in Node environment
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clearInvoiceForm,
    renderInvoiceForm,
    updateConfirmButtonState,
    collectInvoiceFromForm,
    parseInvoice,
    submitDraft,
    escapeHtml,
  };
}
