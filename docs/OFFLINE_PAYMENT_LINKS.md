# Pre-invoices and offline payment links

Last reviewed: 2026-11-17 (Asia/Calcutta). Verify details in source:

- **Services:** `src/services/offlinePayments/` (`service.js` links, customer,
  verification and conversion; `sources.js` the two document adapters;
  `preInvoices.js`; `rules.js`; `mongoStore.js`; `index.js` wiring).
- **Models:** `src/models/crm/preInvoice.js`, `src/models/offlinePaymentLink.js`.
- **HTTP:** `src/controllers/offlinePayments.js`, `src/routes/crm/preInvoice.js`,
  `src/routes/offlinePayments.js`.
- **Swagger:** `src/docs/offlinePayments.js`.
- **Tests:** `test/offlinePayments.test.js`.

An admin sends a customer a link to pay a sale that was agreed offline:

```text
Quotation (optional) ──move──► Pre-invoice ──┐
      │                                       ├─► payment link  /pay/{token}
      └──────────(direct link)────────────────┘        │
customer: open link → Google sign-in → confirm address → PhonePe
PhonePe webhook / status check (server-to-server) → verified paid
  → document Paid → final invoice created once → linked to the customer
```

- **One mechanism for both document kinds.** A link points at a pre-invoice or a
  quotation through a small adapter with the same interface (`load`,
  `isPayable`, `payableSnapshot`, `markPaid`, plus `invoicePayload` and
  `attachInvoice` for conversion). Link, payment, webhook and status code never
  branch on the kind.
- **Where the amount comes from.** It is always the document's stored total in
  the database. Request bodies never carry an amount.
- **What can mark a payment paid.** Only a server-to-server PhonePe status check
  (webhook, admin reconcile, or the status endpoint asking PhonePe). The
  browser redirect never does.
- **The storefront checkout is untouched.** Its `PaymentAttempt`s (`source:
"ECOM"`) and orders, and the legacy `POST /v1/crm/phonepe/payment-link`
  route, work as before.

## Pre-invoices

`AquaPreInvoice` is its own document with its own number series
(`AQPI|YYYYMMDD|0001`), so it never consumes a final invoice number.

- **Fields:** customer details, GST details, quotation-shaped lines (name,
  description, quantity, price, discount, tax, total, productId), `subTotal`,
  `discount`, `tax`, `totalAmount`, `currency` (INR only) and `payment`.
- **Statuses:** `Draft`, `Payment Pending`, `Paid`, `Cancelled`, `Converted`.
- **Totals** are always computed by the server with the quotation formula
  (`src/services/quotation/quotationTotals.js`). Totals sent by a client are
  ignored.
- **Moving a quotation** (`POST /v1/crm/quotations/:id/pre-invoice`) does all of
  the following:
  - copies the lines and totals
  - links both ways (`quotation.convertedToPreInvoice`/`convertedToPreInvoiceNo`,
    `preInvoice.sourceQuotationId/No`)
  - sets the quotation to `Converted` and stops its WhatsApp follow-ups
  - revokes its payment link

  The quotation is kept. A quotation can have one active pre-invoice: a second
  move gives `QUOTATION_ALREADY_MOVED` (`details.preInvoiceId`/`preInvoiceNo`).

- **After a move:**
  - Payment links are allowed only on the pre-invoice (`USE_PRE_INVOICE`,
    `details.preInvoiceId`/`preInvoiceNo`).
  - The existing `POST /v1/crm/quotations/:id/convert-to-invoice` returns 409
    `QUOTATION_MOVED_TO_PRE_INVOICE`, so no second invoice can be made. The
    pre-invoice is in `details.preInvoiceId`/`preInvoiceNo`; a top-level
    `preInvoiceId` is also kept for earlier callers.
- **Editing** (`PATCH`) works only while `Draft` or `Payment Pending` and unpaid.
  `status: "Cancelled"` revokes the link and frees the source quotation (its
  previous status is restored).

## Admin API (CRM staff token + permission)

| Method and path                                                  | Permission             |
| ---------------------------------------------------------------- | ---------------------- |
| `GET /v1/crm/pre-invoices` (`status`, `search`, `page`, `limit`) | `preinvoices.read`     |
| `GET /v1/crm/pre-invoices/:id`                                   | `preinvoices.read`     |
| `POST /v1/crm/pre-invoices`                                      | `preinvoices.manage`   |
| `PATCH /v1/crm/pre-invoices/:id`                                 | `preinvoices.manage`   |
| `POST /v1/crm/quotations/:id/pre-invoice`                        | `preinvoices.manage`   |
| `GET/POST/DELETE /v1/crm/pre-invoices/:id/payment-link`          | `payments.link.manage` |
| `GET/POST/DELETE /v1/crm/quotations/:id/payment-link`            | `payments.link.manage` |
| `POST /v1/crm/pre-invoices/:id/payment-link/send`                | `payments.link.manage` |
| `POST /v1/crm/quotations/:id/payment-link/send`                  | `payments.link.manage` |

- **Permissions:** the three permissions are new and assigned to no role. Only
  super-admin and legacy role 1 have them until someone assigns them in CRM
  Access Control.
- **`POST …/payment-link`** checks that the document is payable. It refuses
  documents that are paid, invoiced, `Sold`, `Converted`, `Rejected` or
  `Expired`, have a zero total, are not in INR, have no valid Indian mobile, or
  when the gateway is disabled.
  - It revokes any active link and creates a new one.
  - It sends the link to the document's mobile on WhatsApp (Fast2SMS
    `paymentLinkRequest` template) unless the body has
    `"notifyCustomer": false`. The response field `customerNotification`
    is `queued`, `not_configured` or `disabled`
    ([PAYMENT_NOTIFICATIONS.md](PAYMENT_NOTIFICATIONS.md)).
  - It returns `url` (`https://aquakart.co.in/pay/{token}`) **once**; only the
    SHA-256 of the 32-byte token is stored.
  - It sets a Draft/Sent/Accepted document to `Payment Pending`.
- **`GET …/payment-link`** shows the latest link without its token:
  - `status`, `expiresAt`, `boundToCustomer`, `reviewFlags`
  - `conversion` (with the invoice number)
  - `paidAttemptId`: the payment attempt that paid the link (null until paid);
    pass it to the reconcile endpoint below
  - `matchesDocument` (false means the document changed and the link must be
    regenerated)
- **`POST …/payment-link/send`** (the CRM "Send" button) re-sends the
  **same** active link to the document's mobile on WhatsApp and waits for
  Fast2SMS. It returns `{ sent, channel, sentAt, link }` and never the URL.
  Errors: `409 NO_ACTIVE_LINK`, `409 LINK_OUTDATED` (document changed),
  `409 LINK_RESEND_UNAVAILABLE` (link made before this feature: create a new
  one), `429 ALREADY_SENT` (once a minute per link), `502 SEND_FAILED`,
  `503 NOTIFICATIONS_NOT_CONFIGURED`.
  - To make this possible the token is also stored sealed (AES-256-GCM,
    `tokenSealed`) with a key from `PAYMENT_LINK_TOKEN_KEY`, or derived from
    `JWT_SECRET`. Lookup still uses only the SHA-256 hash, and no API
    returns the sealed value. Changing the key makes existing links
    un-sendable (they still work for the customer).
- **Reconcile and retry:** `POST /v1/crm/payments/:id/reconcile` (existing,
  `payments.reconcile`) also handles offline attempts. It re-checks with
  PhonePe and retries a missing invoice (for example after stock was short).

## Frontend contract for `/pay/{token}` (AQUAKARTECOM)

Responses use `{ success, data }`. Errors use `{ success: false, code, message,
details? }`. The token is the 43-character URL-safe path segment.

1. **`GET /v1/payments/offline/{token}`** (no auth, 30 requests/min per IP)
   returns:
   - `documentType` (`pre_invoice` or `quotation`), `documentNumber`
   - `products[] { name, description, quantity }`
   - `subTotal`, `discount`, `tax`, `amount`, `currency`, `expiresAt`
   - `payable`, `state` (`payable` or `paid`), `requiresSignIn: true`

   Unknown, revoked, expired, outdated (document changed) and unpayable links
   all return the same `404 LINK_UNAVAILABLE`. Show "This link is invalid or
   has expired, contact Aquakart". If `state` is `paid`, show the paid view and
   call the status endpoint after sign-in.

2. **Sign-in:** Google sign-in as on the invoice pages. Every customer call
   below sends `Authorization: Bearer <Firebase ID token>` and
   `x-aquakart-session: <backend session JWT>`.
3. **`POST /v1/payments/offline/{token}/customer`** with body
   `{ "address": { "street", "city", "state", "postalCode" }, "alternatePhone"? }`:
   - The pincode must be 6 digits, not starting with 0.
   - `alternatePhone` must be a valid Indian mobile.
   - Errors come back as `400 VALIDATION_FAILED` with `details` keyed by field
     (`address.postalCode`, `alternatePhone`, …).
   - The first account to call this owns the link; others get
     `403 LINK_BOUND_TO_ANOTHER_USER`.
   - It returns `{ bound, documentNumber, amount, currency, flaggedForReview }`.
4. **`POST /v1/payments/offline/{token}/initiate`** (no body) returns
   `201 { redirectUrl, amount, currency, status: "pending", reused }`. Send the
   browser to `redirectUrl`.
   - `409 CUSTOMER_DETAILS_REQUIRED`: step 3 isn't done yet.
   - `409 ALREADY_PAID`, `409 OUT_OF_STOCK` ("contact Aquakart").
   - `409 PAYMENT_IN_PROGRESS`: retry after a few seconds.
   - `502/503 GATEWAY_ERROR` or `GATEWAY_DISABLED`.
5. **Return:** PhonePe sends the browser back to `/pay/{token}?return=1`. Call
   `GET /v1/payments/offline/{token}/status`; poll every few seconds while
   `status` is `pending`. The server asks PhonePe itself. It returns:
   - `status` (`not_started`, `pending`, `paid`, `failed`, `expired`, `refunded`),
     `linkStatus`, `source: "CRM_OFFLINE"`
   - `documentType`, `documentNumber`, `quotationNo`, `preInvoiceNo`, `invoiceNo`,
     `invoiceReady`
   - `products`, `amount`, `amountPaid`, `currency`, `gatewayTransactionId`,
     `paidAt`

   The receipt reference is `invoiceNo` plus `gatewayTransactionId`; there is
   no separate receipt. Once `invoiceReady` is true, the invoice is in the
   customer's existing "my invoices" view. On `failed` or `expired`, offer
   "Try again" (step 4).

Never send or display an amount from the client; never treat the redirect
itself as success.

## Customer account rules

- **Saving details.** The confirmed address is appended to `user.addresses`
  (identical addresses aren't duplicated; nothing is overwritten).
  `selectedAddress` is set only if empty. `alternatePhone` (new field) is
  saved.
- **Phone already on another account.** If the document's mobile belongs to a
  different account, the signed-in account continues and the link gets
  `reviewFlags: ["PHONE_ON_OTHER_ACCOUNT"]` plus an audit entry. Accounts are
  never merged, and `user.phone` is not changed. There are no OTP or password
  flows.
- **Linking the invoice.** After conversion, the invoice is linked to the
  customer: `invoice.firebaseUid` (if empty) and `user.invoices[]`.
- **Invoice address.** The address the customer confirmed is used on the
  invoice only when the document has none.

## Payment verification and finalisation

- **`PaymentAttempt` fields:**
  - New `source` (`ECOM` by default), plus `sourceKind`, `sourceId` and
    `paymentLinkId`.
  - `checkoutSessionId` is required only for `ECOM`.
  - Offline attempts use `AQPL…` merchant transaction ids and go through the
    existing PhonePe service and webhook
    (`POST /v1/webhooks/payments/phonepe/:transactionId`).
- **Initiate:**
  - One initiate at a time per link (a 30-second claim).
  - A pending attempt is re-checked with PhonePe. It's reused if it's younger
    than `OFFLINE_PAYMENT_ATTEMPT_TTL_MINUTES`; otherwise it's marked
    `expired`.
  - Stock is checked (read-only) before payment.
- **Paid** requires all of these to match:
  - the merchant id
  - the merchant transaction id
  - INR
  - the gateway amount in paise against the attempt amount

  A mismatch is rejected (`VERIFICATION_MISMATCH`), audited, and nothing is
  marked paid.

- **Then, in order** (each step guarded and idempotent):
  1. The attempt becomes `paid`, and only once.
  2. The link becomes `paid`. A second successful attempt on the same link is
     flagged `DUPLICATE_PAYMENT` for a refund decision and never gets a second
     invoice.
  3. The document is marked `Paid` (`payment.amountPaid`, `transactionId`,
     `paidAt`, `mode`). If its total changed after payment started, it isn't
     marked: the link gets `needs_review` and `AMOUNT_CHANGED_AFTER_PAYMENT`.
  4. The final invoice is created exactly once:
     - Through the existing `persistInvoice`, which consumes stock and sends the
       invoice on WhatsApp, as a CRM conversion does. When the
       `paymentReceived` template is configured, the customer gets that
       receipt with the invoice link instead, and the admin is alerted as soon
       as the payment is verified ([PAYMENT_NOTIFICATIONS.md](PAYMENT_NOTIFICATIONS.md)).
     - **A quotation paid directly** becomes `Sold` with `convertedToInvoice`,
       like the CRM conversion.
     - **A pre-invoice** gets `invoice.sourcePreInvoiceId` (unique index), plus
       `sourceQuotationId` if it came from a quotation. The pre-invoice
       becomes `Converted`, and its quotation `Sold`.
     - If stock is short, the payment stays recorded and `conversion.status`
       is `blocked_stock`. Webhook retries and admin reconcile retry it.
- **Pending, failed, expired:**
  - `pending` and `failed` update the attempt only. A failed link stays
    usable for another try.
  - A later failure never downgrades a paid attempt.
  - `refunded` and `partially_refunded` attempts are never flipped back to
    paid.
- **Refunds aren't detected automatically.** PhonePe's status API doesn't
  report them; a refund is handled outside this flow.
- **Not touched:** no cart, cart order or delivery status. The invoice is a
  normal sales invoice (`quotation: false`), so service reminders and
  warranty logic see it.

## Environment

None are required beyond the existing PhonePe, `API_BASE_URL`, `ECOM_BASE_URL`,
`JWT_SECRET` and Firebase settings. Optional settings:

| Variable                              | Default         | Meaning                                      |
| ------------------------------------- | --------------- | -------------------------------------------- |
| `OFFLINE_PAYMENT_LINK_TTL_HOURS`      | 72 (max 720)    | Link lifetime                                |
| `OFFLINE_PAYMENT_ATTEMPT_TTL_MINUTES` | 15 (max 120)    | How long a pending PhonePe attempt is reused |
| `OFFLINE_PAYMENT_PUBLIC_BASE_URL`     | `ECOM_BASE_URL` | Origin of the `/pay/{token}` page            |

These are read at startup.

## Database

- **New collections:**
  - `aquapreinvoices` (unique `preInvoiceNo`)
  - `aquaofflinepaymentlinks`, with these indexes:
    - unique `tokenHash`
    - partial-unique `{source.kind, source.id}` while `status: "active"`
    - `{source.id, createdAt}`
- **New fields:**
  - `AquaPaymentAttempt`: `source` (indexed), `sourceKind`, `sourceId`,
    `paymentLinkId`. `checkoutSessionId` is now conditionally required.
  - `AquaInvoice`: `sourcePreInvoiceId`/`No`, with a partial-unique index on
    real ids only.
  - `AquaQuotation`: `convertedToPreInvoice`, `convertedToPreInvoiceNo`.
  - `AquaEcomUser`: `alternatePhone`.

All changes are additive; existing documents need no migration.

## Deploy and rollback

- **Deploy:**
  1. Merge, then deploy through the existing pipeline. There are no new
     dependencies.
  2. Watch the startup log for index builds.
  3. Assign `payments.link.manage` and `preinvoices.*` to the right roles.
  4. Confirm PhonePe is configured. Without it, link creation returns
     `GATEWAY_DISABLED`.
  5. Verify with a small real sale on a test pre-invoice, or in PhonePe UAT by
     pointing `PHONEPE_BASE_URL` at the sandbox on a staging instance.
- **Rollback:** deploy the previous build.
  - Existing data keeps working. New fields and collections are ignored by
    old code, and storefront attempts are unaffected.
  - Links created meanwhile stop working, and the old webhook code does not
    know offline attempts, so it can't finish them correctly. Before rolling
    back, revoke active links (or let them expire) and reconcile any pending
    offline attempts.
