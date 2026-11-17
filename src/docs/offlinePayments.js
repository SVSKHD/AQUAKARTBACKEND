// Explicit contracts for pre-invoices and admin-created offline payment
// links (src/routes/crm/preInvoice.js, src/routes/offlinePayments.js).
// Full description: docs/OFFLINE_PAYMENT_LINKS.md.

const ADMIN_TAG = "CRM / Pre-invoices & Payment Links";
const PUBLIC_TAG = "Payments / Offline Links";

const error = (description, codes) => ({
  description,
  schema: {
    type: "object",
    properties: {
      success: { type: "boolean", example: false },
      code: { type: "string", enum: codes },
      message: { type: "string" },
      details: { type: "object" },
    },
  },
});
const ok = (data) => ({
  type: "object",
  properties: { success: { type: "boolean", example: true }, data },
});
const staffAuth = {
  name: "Authorization",
  in: "header",
  type: "string",
  required: true,
  description: "Bearer <CRM staff JWT>",
};
const firebaseAuth = {
  name: "Authorization",
  in: "header",
  type: "string",
  required: true,
  description: "Bearer <Firebase Google ID token>",
};
const session = {
  name: "x-aquakart-session",
  in: "header",
  type: "string",
  required: true,
  description: "Aquakart backend session JWT from Google sign-in",
};
const idParam = {
  name: "id",
  in: "path",
  type: "string",
  required: true,
  pattern: "^[a-f0-9]{24}$",
};
const tokenParam = {
  name: "token",
  in: "path",
  type: "string",
  required: true,
  pattern: "^[A-Za-z0-9_-]{43}$",
  description: "Payment link token from /pay/{token}",
};
const staffErrors = {
  401: error("Missing or invalid staff token", ["AUTH"]),
  403: error("Missing permission", ["FORBIDDEN"]),
  500: error("Server error", ["SERVER_ERROR"]),
};

const line = {
  type: "object",
  required: ["productName", "productQuantity", "productPrice"],
  properties: {
    productId: { type: "string", pattern: "^[a-f0-9]{24}$" },
    productName: { type: "string" },
    productDescription: { type: "string" },
    productSerialNo: { type: "string" },
    productQuantity: { type: "number", minimum: 0, exclusiveMinimum: true },
    productPrice: { type: "number", minimum: 0 },
    productDiscount: { type: "number", minimum: 0 },
    productTax: { type: "number", minimum: 0 },
  },
};
const preInvoiceBody = {
  type: "object",
  properties: {
    date: { type: "string", example: "2026-11-18" },
    customerDetails: {
      type: "object",
      properties: {
        name: { type: "string" },
        phone: {
          type: "string",
          description: "10-digit Indian mobile, optional +91",
        },
        email: { type: "string" },
        address: { type: "string" },
      },
    },
    gst: { type: "boolean" },
    gstDetails: {
      type: "object",
      description: "gstNo and gstName required when gst is true",
    },
    products: { type: "array", items: line, minItems: 1, maxItems: 100 },
    discount: { type: "number", minimum: 0 },
    tax: { type: "number", minimum: 0 },
    currency: { type: "string", enum: ["INR"] },
    status: {
      type: "string",
      enum: ["Draft", "Payment Pending", "Cancelled"],
      description: "PATCH only",
    },
  },
  description:
    "Totals are always computed by the server; subTotal/totalAmount in the body are ignored.",
};
const linkState = {
  type: "object",
  properties: {
    linkId: { type: "string" },
    status: { type: "string", enum: ["active", "revoked", "expired", "paid"] },
    source: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pre_invoice", "quotation"] },
        id: { type: "string" },
        number: { type: "string" },
      },
    },
    amount: { type: "number" },
    currency: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    boundToCustomer: { type: "boolean" },
    reviewFlags: { type: "array", items: { type: "string" } },
    paidAt: { type: "string", format: "date-time" },
    amountPaid: { type: "number" },
    gatewayTransactionId: { type: "string" },
    conversion: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [
            "none",
            "in_progress",
            "done",
            "failed",
            "blocked_stock",
            "needs_review",
          ],
        },
        invoiceId: { type: "string" },
        invoiceNo: { type: "string" },
        lastError: { type: "string" },
      },
    },
    matchesDocument: {
      type: "boolean",
      description:
        "GET only: false when the document changed and the link must be regenerated",
    },
  },
};
const publicProducts = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      quantity: { type: "number" },
    },
  },
};
const unavailable = error(
  "Unknown, revoked, expired, outdated or unpayable link (identical response)",
  ["LINK_UNAVAILABLE"],
);

const linkOps = (kind, permission) => ({
  get: {
    tags: [ADMIN_TAG],
    summary: `Current payment link of a ${kind}`,
    description: `Permission ${permission}. Never returns the token.`,
    parameters: [idParam, staffAuth],
    responses: {
      200: {
        description: "Latest link or null",
        schema: ok({ type: "object", properties: { link: linkState } }),
      },
      ...staffErrors,
    },
  },
  post: {
    tags: [ADMIN_TAG],
    summary: `Create or regenerate the payment link of a ${kind}`,
    description: `Permission ${permission}. Revokes the previous active link and returns the new URL once (only a hash is stored). The amount is the ${kind}'s stored total. ${kind === "quotation" ? "Refused with USE_PRE_INVOICE once the quotation was moved to a pre-invoice." : ""}`,
    parameters: [idParam, staffAuth],
    responses: {
      201: {
        description: "Link created",
        schema: ok({
          ...linkState,
          properties: {
            url: {
              type: "string",
              example: "https://aquakart.co.in/pay/{token}",
            },
            ...linkState.properties,
          },
        }),
      },
      400: error("Document needs a valid customer mobile", [
        "CUSTOMER_PHONE_INVALID",
      ]),
      404: error("Document not found", ["SOURCE_NOT_FOUND"]),
      409: error(
        "Not payable (paid, invoiced, rejected, expired, zero total, non-INR) or quotation moved",
        ["NOT_PAYABLE", "USE_PRE_INVOICE"],
      ),
      503: error("PhonePe not configured or disabled", ["GATEWAY_DISABLED"]),
      ...staffErrors,
    },
  },
  delete: {
    tags: [ADMIN_TAG],
    summary: `Revoke the active payment link of a ${kind}`,
    description: `Permission ${permission}.`,
    parameters: [idParam, staffAuth],
    responses: {
      200: {
        description: "Revoked count",
        schema: ok({
          type: "object",
          properties: { revoked: { type: "number" } },
        }),
      },
      404: error("Document not found", ["SOURCE_NOT_FOUND"]),
      ...staffErrors,
    },
  },
});

export const applyOfflinePaymentDocs = (doc) => {
  doc.paths ||= {};
  doc.paths["/v1/crm/pre-invoices"] = {
    get: {
      tags: [ADMIN_TAG],
      summary: "List pre-invoices",
      description: "Permission preinvoices.read. Newest first.",
      parameters: [
        {
          name: "status",
          in: "query",
          type: "string",
          enum: ["Draft", "Payment Pending", "Paid", "Cancelled", "Converted"],
        },
        {
          name: "search",
          in: "query",
          type: "string",
          description: "Pre-invoice number, customer name or quotation number",
        },
        { name: "page", in: "query", type: "integer", minimum: 1 },
        {
          name: "limit",
          in: "query",
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        staffAuth,
      ],
      responses: {
        200: { description: "Page of pre-invoices with pagination" },
        ...staffErrors,
      },
    },
    post: {
      tags: [ADMIN_TAG],
      summary: "Create a pre-invoice",
      description:
        "Permission preinvoices.manage. Numbered AQPI|YYYYMMDD|NNNN; starts as Draft.",
      parameters: [
        { name: "body", in: "body", required: true, schema: preInvoiceBody },
        staffAuth,
      ],
      responses: {
        201: { description: "Created: { preInvoice, paymentLink }" },
        400: error("Invalid fields", ["VALIDATION_FAILED"]),
        ...staffErrors,
      },
    },
  };
  doc.paths["/v1/crm/pre-invoices/{id}"] = {
    get: {
      tags: [ADMIN_TAG],
      summary: "Get a pre-invoice with its payment-link state",
      description: "Permission preinvoices.read.",
      parameters: [idParam, staffAuth],
      responses: {
        200: { description: "{ preInvoice, paymentLink }" },
        404: error("Not found", ["PRE_INVOICE_NOT_FOUND"]),
        ...staffErrors,
      },
    },
    patch: {
      tags: [ADMIN_TAG],
      summary: "Edit or cancel an unpaid pre-invoice",
      description:
        "Permission preinvoices.manage. Only while Draft or Payment Pending and unpaid. Changing lines or totals makes an existing payment link stop working (regenerate it). status Cancelled revokes the link and frees the source quotation.",
      parameters: [
        idParam,
        { name: "body", in: "body", required: true, schema: preInvoiceBody },
        staffAuth,
      ],
      responses: {
        200: { description: "{ preInvoice, paymentLink }" },
        400: error("Invalid or empty update", [
          "VALIDATION_FAILED",
          "NOTHING_TO_UPDATE",
        ]),
        404: error("Not found", ["PRE_INVOICE_NOT_FOUND"]),
        409: error("Paid, converted or cancelled", ["PRE_INVOICE_LOCKED"]),
        ...staffErrors,
      },
    },
  };
  doc.paths["/v1/crm/quotations/{id}/pre-invoice"] = {
    post: {
      tags: [ADMIN_TAG],
      summary: "Move a quotation to a pre-invoice",
      description:
        "Permission preinvoices.manage. Copies lines and totals, links both ways, sets the quotation to Converted, stops its WhatsApp follow-ups and revokes its payment link. The quotation is kept. One active pre-invoice per quotation.",
      parameters: [idParam, staffAuth],
      responses: {
        201: {
          description: "{ preInvoice, paymentLink, quotationLinksRevoked }",
        },
        404: error("Quotation not found", ["QUOTATION_NOT_FOUND"]),
        409: error(
          "Already moved, already invoiced, or rejected/expired/sold/paid",
          [
            "QUOTATION_ALREADY_MOVED",
            "QUOTATION_ALREADY_INVOICED",
            "QUOTATION_NOT_MOVABLE",
          ],
        ),
        ...staffErrors,
      },
    },
  };
  doc.paths["/v1/crm/pre-invoices/{id}/payment-link"] = linkOps(
    "pre-invoice",
    "payments.link.manage",
  );
  doc.paths["/v1/crm/quotations/{id}/payment-link"] = linkOps(
    "quotation",
    "payments.link.manage",
  );

  doc.paths["/v1/payments/offline/{token}"] = {
    get: {
      tags: [PUBLIC_TAG],
      summary: "Public summary of a payment link",
      description:
        "No sign-in. Returns only the document number and type, product names/descriptions/quantities, subtotal, discount, tax, amount, currency, expiry and whether it can be paid. No ids, customer data, notes or terms. Rate limited (30/min per IP).",
      parameters: [tokenParam],
      responses: {
        200: {
          description:
            "Payable (state payable) or already paid (state paid, payable false)",
          schema: ok({
            type: "object",
            properties: {
              documentType: {
                type: "string",
                enum: ["pre_invoice", "quotation"],
              },
              documentNumber: { type: "string" },
              products: publicProducts,
              subTotal: { type: "number" },
              discount: { type: "number" },
              tax: { type: "number" },
              amount: { type: "number" },
              currency: { type: "string", example: "INR" },
              expiresAt: { type: "string", format: "date-time" },
              payable: { type: "boolean" },
              state: { type: "string", enum: ["payable", "paid"] },
              requiresSignIn: { type: "boolean" },
            },
          }),
        },
        404: unavailable,
        429: error("Rate limited", ["RATE_LIMITED"]),
      },
    },
  };
  doc.paths["/v1/payments/offline/{token}/customer"] = {
    post: {
      tags: [PUBLIC_TAG],
      summary:
        "Confirm customer details and bind the link to the signed-in account",
      description:
        "Google sign-in required. The first signed-in account to call this owns the link; others get 403. The address is appended to the account (never overwrites) and alternatePhone is saved. If the document's mobile belongs to another account the link is flagged for admin review; accounts are never merged.",
      parameters: [
        tokenParam,
        firebaseAuth,
        session,
        {
          name: "body",
          in: "body",
          required: true,
          schema: {
            type: "object",
            required: ["address"],
            properties: {
              address: {
                type: "object",
                required: ["street", "city", "state", "postalCode"],
                properties: {
                  street: { type: "string", minLength: 5 },
                  city: { type: "string" },
                  state: { type: "string" },
                  postalCode: { type: "string", pattern: "^[1-9][0-9]{5}$" },
                },
              },
              alternatePhone: {
                type: "string",
                description: "Optional 10-digit Indian mobile",
              },
            },
          },
        },
      ],
      responses: {
        200: {
          description: "Bound",
          schema: ok({
            type: "object",
            properties: {
              bound: { type: "boolean" },
              documentNumber: { type: "string" },
              amount: { type: "number" },
              currency: { type: "string" },
              flaggedForReview: { type: "boolean" },
            },
          }),
        },
        400: error("Invalid address or phone", ["VALIDATION_FAILED"]),
        401: error("Google sign-in required", ["AUTH"]),
        403: error("Link belongs to another account", [
          "LINK_BOUND_TO_ANOTHER_USER",
        ]),
        404: unavailable,
        409: error("Already paid", ["ALREADY_PAID"]),
      },
    },
  };
  doc.paths["/v1/payments/offline/{token}/initiate"] = {
    post: {
      tags: [PUBLIC_TAG],
      summary: "Start (or resume) the PhonePe payment",
      description:
        "Same signed-in account. No body: the amount is always the document's stored total. Reuses a still-pending attempt (reused true) for OFFLINE_PAYMENT_ATTEMPT_TTL_MINUTES; refuses when already paid or when stock is short. Redirect the browser to redirectUrl; PhonePe returns to /pay/{token}?return=1.",
      parameters: [tokenParam, firebaseAuth, session],
      responses: {
        201: {
          description: "Payment started",
          schema: ok({
            type: "object",
            properties: {
              redirectUrl: { type: "string" },
              amount: { type: "number" },
              currency: { type: "string" },
              status: { type: "string", enum: ["pending"] },
              reused: { type: "boolean" },
            },
          }),
        },
        401: error("Google sign-in required", ["AUTH"]),
        403: error("Link belongs to another account", [
          "LINK_BOUND_TO_ANOTHER_USER",
        ]),
        404: unavailable,
        409: error(
          "Details missing, already paid, payment starting, out of stock",
          [
            "CUSTOMER_DETAILS_REQUIRED",
            "ALREADY_PAID",
            "PAYMENT_IN_PROGRESS",
            "OUT_OF_STOCK",
          ],
        ),
        502: error("Gateway error", ["GATEWAY_ERROR"]),
        503: error("Payments not available", [
          "GATEWAY_DISABLED",
          "GATEWAY_ERROR",
        ]),
      },
    },
  };
  doc.paths["/v1/payments/offline/{token}/status"] = {
    get: {
      tags: [PUBLIC_TAG],
      summary: "Verified payment status",
      description:
        "Same signed-in account. If the latest attempt is pending the server asks PhonePe directly (the browser redirect is never trusted). invoiceReady is true once the final invoice exists.",
      parameters: [tokenParam, firebaseAuth, session],
      responses: {
        200: {
          description: "Status",
          schema: ok({
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: [
                  "not_started",
                  "created",
                  "pending",
                  "paid",
                  "failed",
                  "expired",
                  "refunded",
                  "partially_refunded",
                ],
              },
              linkStatus: {
                type: "string",
                enum: ["active", "revoked", "expired", "paid"],
              },
              source: { type: "string", enum: ["CRM_OFFLINE"] },
              documentType: { type: "string" },
              documentNumber: { type: "string" },
              quotationNo: { type: "string" },
              preInvoiceNo: { type: "string" },
              invoiceNo: { type: "string" },
              invoiceReady: { type: "boolean" },
              products: publicProducts,
              amount: { type: "number" },
              amountPaid: { type: "number" },
              currency: { type: "string" },
              gatewayTransactionId: { type: "string" },
              paidAt: { type: "string", format: "date-time" },
            },
          }),
        },
        401: error("Google sign-in required", ["AUTH"]),
        403: error("Link belongs to another account", [
          "LINK_BOUND_TO_ANOTHER_USER",
        ]),
        404: unavailable,
        409: error("Customer details not confirmed yet", [
          "CUSTOMER_DETAILS_REQUIRED",
        ]),
      },
    },
  };
  return doc;
};
