const { z } = require('zod');

// NOTE: Money values (such as unitAmount) are maintained as numbers with up to 2 decimal places
// during schema modeling and validation. In subsequent phases, PayPal payload conversion must
// format monetary values as strings with exactly two decimal places (e.g. "100.00").

/**
 * Validates that a numeric value has at most 2 decimal places.
 * @param {number} val
 * @returns {boolean}
 */
function hasMaxTwoDecimals(val) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return false;
  const parts = val.toString().split('.');
  if (parts.length === 1) return true;
  if (parts.length === 2) return parts[1].length <= 2;
  return false;
}

/**
 * Validates ISO date in YYYY-MM-DD format and verifies it is a valid calendar date.
 * @param {string} val
 * @returns {boolean}
 */
function isValidIsoDate(val) {
  if (typeof val !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const d = new Date(val + 'T00:00:00.000Z');
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === val;
}

const isoDateSchema = z
  .string()
  .refine(isValidIsoDate, {
    message: 'dueDate must be a valid ISO date in YYYY-MM-DD format',
  });

const ALLOWED_FIELD_NAMES = [
  'recipientName',
  'recipientEmail',
  'currency',
  'dueDate',
  'items',
  'description',
  'quantity',
  'unitAmount',
];

const ambiguitySchema = z
  .object({
    field: z.string().trim().min(1, 'Field name is required'),
    question: z.string().trim().min(1, 'Question is required'),
  })
  .strict();

/**
 * Schema for an individual invoice line item.
 */
const invoiceItemSchema = z
  .object({
    description: z.string().trim().min(1, 'Description cannot be empty'),
    quantity: z.number().positive('Quantity must be greater than 0'),
    unitAmount: z
      .number()
      .positive('Unit amount must be greater than 0')
      .refine(hasMaxTwoDecimals, {
        message: 'Unit amount cannot have more than 2 decimal places',
      }),
  })
  .strict();

/**
 * Schema for draft invoice extracted from natural language.
 * Allows null/missing recipient details and dates without guessing.
 */
const invoiceDraftSchema = z
  .object({
    recipientName: z.string().trim().min(1, 'Recipient name cannot be empty').nullable().optional(),
    recipientEmail: z.string().trim().email('Invalid email address').nullable().optional(),
    currency: z.literal('USD', {
      message: 'Currency must be USD',
    }),
    dueDate: isoDateSchema.nullable().optional(),
    items: z
      .array(invoiceItemSchema)
      .min(1, 'Invoice draft must have at least 1 item')
      .max(3, 'Invoice draft cannot exceed 3 items'),
    missingFields: z.array(z.enum(ALLOWED_FIELD_NAMES)).default([]),
    ambiguities: z.array(ambiguitySchema).default([]),
  })
  .strict();

/**
 * Schema for validated invoice ready for PayPal submission.
 * Rejects null recipient fields and requires complete, valid items.
 */
const validatedInvoiceSchema = z
  .object({
    recipientName: z.string().trim().min(1, 'Recipient name cannot be empty'),
    recipientEmail: z.string().trim().email('Invalid recipient email'),
    currency: z.literal('USD', {
      message: 'Currency must be USD',
    }),
    dueDate: isoDateSchema.nullable().optional(),
    items: z
      .array(invoiceItemSchema)
      .min(1, 'Invoice must have at least 1 item')
      .max(3, 'Invoice cannot exceed 3 items'),
  })
  .strict();

/**
 * Normalizes Zod issues into a consistent error list.
 * @param {import('zod').ZodError} error
 * @returns {Array<{ path: string, field: string, message: string }>}
 */
function formatZodErrors(error) {
  return error.issues.map((issue) => {
    const pathStr = issue.path.join('.') || 'root';
    return {
      path: pathStr,
      field: pathStr,
      message: issue.message,
    };
  });
}

/**
 * Parses and validates an invoice draft object without throwing.
 * @param {unknown} input
 * @returns {{ success: true, data: any } | { success: false, errors: Array<{ path: string, field: string, message: string }> }}
 */
function parseInvoiceDraft(input) {
  try {
    const result = invoiceDraftSchema.safeParse(input);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      errors: formatZodErrors(result.error),
    };
  } catch (err) {
    return {
      success: false,
      errors: [{ path: 'root', field: 'root', message: err.message || 'Validation failed' }],
    };
  }
}

/**
 * Parses and validates an invoice object for PayPal submission without throwing.
 * @param {unknown} input
 * @returns {{ success: true, data: any } | { success: false, errors: Array<{ path: string, field: string, message: string }> }}
 */
function parseValidatedInvoice(input) {
  try {
    const result = validatedInvoiceSchema.safeParse(input);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return {
      success: false,
      errors: formatZodErrors(result.error),
    };
  } catch (err) {
    return {
      success: false,
      errors: [{ path: 'root', field: 'root', message: err.message || 'Validation failed' }],
    };
  }
}

module.exports = {
  invoiceItemSchema,
  invoiceDraftSchema,
  validatedInvoiceSchema,
  parseInvoiceDraft,
  parseValidatedInvoice,
  ALLOWED_FIELD_NAMES,
};
