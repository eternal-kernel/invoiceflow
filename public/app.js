// Minimal client-side script for InvoiceFlow UI
// Handles parse and draft creation via the backend API.

async function parseInvoice() {
  const text = document.getElementById('invoice-text').value.trim();
  if (!text) {
    showMessage('Please enter invoice text.', 'error');
    return;
  }
  setLoading(true);
  try {
    const res = await fetch('/api/invoice/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      showMessage('Parse error: ' + (data.errors?.[0]?.message || 'Unknown'), 'error');
      setLoading(false);
      return;
    }
    renderInvoiceForm(data.data);
  } catch (e) {
    showMessage('Network error while parsing.', 'error');
  }
  setLoading(false);
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
      showMessage('Draft creation error: ' + (data.errors?.[0]?.message || 'Unknown'), 'error');
      setLoading(false);
      return;
    }
    showMessage('Draft created: ID ' + data.data.id, 'success');
  } catch (e) {
    showMessage('Network error while creating draft.', 'error');
  }
  setLoading(false);
}

function setLoading(isLoading) {
  document.getElementById('loading').style.display = isLoading ? 'block' : 'none';
}

function showMessage(msg, type) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.className = type;
}

function renderInvoiceForm(parsed) {
  // Simple rendering: fill form fields, make confirm button visible.
  const form = document.getElementById('invoice-form');
  form.style.display = 'block';
  // Populate fields safely using textContent/value.
  if (parsed.recipientName) document.getElementById('recipientName').value = parsed.recipientName;
  if (parsed.recipientEmail) document.getElementById('recipientEmail').value = parsed.recipientEmail;
  if (parsed.currency) document.getElementById('currency').value = parsed.currency;
  if (parsed.dueDate) document.getElementById('dueDate').value = parsed.dueDate;
  // Items – limited to 3 lines.
  const itemsContainer = document.getElementById('items');
  itemsContainer.innerHTML = '';
  (parsed.items || []).slice(0, 3).forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `
      <input type="text" placeholder="Description" id="desc${idx}" value="${escapeHtml(it.description)}" />
      <input type="number" placeholder="Qty" id="qty${idx}" value="${it.quantity}" min="1" />
      <input type="number" placeholder="Unit Amount" id="unit${idx}" value="${it.unitAmount}" step="0.01" min="0" />
    `;
    itemsContainer.appendChild(row);
  });
  // Show confirm button.
  document.getElementById('confirm-section').style.display = 'block';
}

function collectInvoiceFromForm() {
  const recipientName = document.getElementById('recipientName').value.trim();
  const recipientEmail = document.getElementById('recipientEmail').value.trim();
  const currency = document.getElementById('currency').value.trim();
  const dueDate = document.getElementById('dueDate').value.trim();

  if (!recipientName || !recipientEmail || !currency || !dueDate) {
    showMessage('All main fields are required.', 'error');
    return null;
  }

  const items = [];
  for (let i = 0; i < 3; i++) {
    const desc = document.getElementById(`desc${i}`);
    const qty = document.getElementById(`qty${i}`);
    const unit = document.getElementById(`unit${i}`);
    if (desc && qty && unit && desc.value) {
      const quantity = parseInt(qty.value, 10);
      const unitAmount = parseFloat(unit.value);
      if (isNaN(quantity) || quantity <= 0 || isNaN(unitAmount) || unitAmount <= 0) {
        showMessage('Invalid item quantity or unit amount.', 'error');
        return null;
      }
      items.push({ description: desc.value, quantity, unitAmount });
    }
  }

  if (items.length === 0) {
    showMessage('At least one item is required.', 'error');
    return null;
  }

  return { recipientName, recipientEmail, currency, dueDate, items };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"]+/g, function (s) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;'
    }[s] || s;
  });
}

// Attach event listeners after DOM load.
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('parseBtn').addEventListener('click', parseInvoice);
  document.getElementById('createDraftBtn').addEventListener('click', submitDraft);
});
