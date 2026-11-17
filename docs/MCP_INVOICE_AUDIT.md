# MCP invoice data-quality audit

Last reviewed: 2026-11-17 (Asia/Calcutta). Verify details in source:
`src/services/mcp/invoiceAuditRules.js` (rules and confidence tables),
`src/services/mcp/invoiceAuditTools.js` (scan, list, get, history),
`src/services/mcp/invoiceActionTools.js` (execute, ignore),
`src/services/mcp/invoiceStore.js` (MongoDB access),
`src/services/mcp/invoiceSchemas.js` (tool schemas),
`src/models/mcp/invoiceAction.js`. Tests: `test/mcpInvoiceAudit.test.js`.
OAuth, transport and the other MCP tools are in
[MCP_BLOG_PUBLISHING.md](MCP_BLOG_PUBLISHING.md).

The audit finds invoices with missing customer addresses and possible
duplicate invoices. Each finding is saved as a **suggested action** for review.

- **A scan never changes an invoice.** It only creates or refreshes
  suggested-action records (`AquaMcpInvoiceAction`); with `dryRun` it saves
  nothing at all.
- **The only invoice change MCP can make** is filling a _missing_
  `customerDetails.address` from evidence the scan found. It happens only
  after explicit admin approval, through `aquakart_execute_invoice_action`.
- **Never changed:** totals, GST, products, invoice numbers and dates.
  Nothing is ever deleted, voided, merged or renumbered.

```text
aquakart_audit_invoices -> suggested actions (pending_review)
  -> review (aquakart_get_invoice_action, in ChatGPT/Claude or the CRM team)
  -> explicit admin approval
  -> aquakart_execute_invoice_action (re-validated on the server) -> audit log
  or aquakart_ignore_invoice_action (no invoice change)
```

## Access

| Scope              | CRM permission           | Tools                                                                                                                           |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `invoices:audit`   | `invoices.audit`         | `aquakart_audit_invoices`, `aquakart_list_invoice_actions`, `aquakart_get_invoice_action`, `aquakart_get_invoice_audit_history` |
| `invoices:actions` | `invoices.audit.execute` | `aquakart_execute_invoice_action`, `aquakart_ignore_invoice_action`                                                             |

- Both permissions are new and **assigned to no role**. Only super-admin and
  legacy role 1 have them until someone assigns them in CRM Access Control.
- `invoices.read` / `invoices.manage` do **not** grant these scopes. No blog,
  Instagram, catalogue or SEO scope reaches invoice data.
- Both scopes start **unticked** on the consent page.
- Storefront customers can't sign in to MCP: only CRM staff accounts can
  authorize.
- Settings are read at startup (`src/services/mcp/config.js`
  `loadInvoiceAuditConfig`):
  - `MCP_INVOICE_DUPLICATE_WINDOW_DAYS` (default 1)
  - `MCP_INVOICE_SCAN_MAX_INVOICES` (default 500 per page)
  - `MCP_INVOICE_SCAN_MAX_RANGE_DAYS` (default 366)
  - `MCP_INVOICE_EXECUTION_LOCK_SECONDS` (default 120)

## Which records a scan covers

- **Selection:** invoices whose record `createdAt` falls in `from`..`to`, oldest
  first by `_id`.
  - Defaults: the last 90 days.
  - A range longer than `MCP_INVOICE_SCAN_MAX_RANGE_DAYS` is refused with
    `RANGE_TOO_LARGE`.
  - Continue with `cursor` (`nextCursor`).
- **Document kinds:** `documentKinds` defaults to `["invoice"]`.
  - Documents with `quotation: true` or `po: true` are scanned only when
    asked for.
  - Even then, they are compared only with documents of the same kind. A
    quotation and the invoice made from it are never paired.
- **Migrated records:** `migrated: true` (bulk-imported) records are skipped
  unless `includeMigrated: true`. Even then:
  - they are compared only with other migrated records
  - they are compared only on an identical invoice number

## Missing addresses

**Address classification** (`classifyAddress`):

| Status        | Meaning                                                                            | Suggestion type                                               |
| ------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `missing`     | `null`, empty or whitespace-only                                                   | `FILL_MISSING_ADDRESS`, or `REQUEST_ADDRESS` without evidence |
| `placeholder` | `N/A`, `-`, `nil`, `none`, `not available`, `0`… (compared on letters/digits only) | same as missing                                               |
| `incomplete`  | fewer than 12 letters/digits                                                       | `REVIEW_INCOMPLETE_ADDRESS` (never executable)                |

An existing (even incomplete) address is never rewritten through MCP.

**Evidence and confidence** (`ADDRESS_SOURCES`). Mobile numbers are
normalized with `normalizeIndianPhone` before comparing.

| Tier | Source                   | Where it is read from                                                                        | Confidence |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------- | ---------- |
| 1    | `linked_order_shipping`  | `AquaOrder` = `invoice.sourceOrderId`, or with `invoiceId` = this invoice: `shippingAddress` | 0.95       |
| 1    | `linked_order_billing`   | same order: `billingAddress`                                                                 | 0.90       |
| 1    | `linked_crm_order`       | `AquaCRMOrder` with `invoiceId` = this invoice: `customer.address/city/pincode`              | 0.95       |
| 2    | `linked_quotation`       | `AquaQuotation` = `invoice.sourceQuotationId`: `customerDetails.address`                     | 0.90       |
| 3    | `linked_account_address` | `AquaEcomUser` with the invoice's `firebaseUid`: saved addresses                             | 0.75       |
| 4    | `phone_account_address`  | `AquaEcomUser` with the same phone: saved addresses                                          | 0.50       |
| 4    | `phone_invoice_history`  | other invoices with the same `customerPhoneNormalized`                                       | 0.45       |

**Ranking** (`rankAddressCandidates`). Candidates are de-duplicated on
letters/digits.

- **Tier 1-2 values agree:** that value is suggested, with the confidence of
  its best source.
- **Tier 1-2 values disagree:** `evidence.conflict: true` and no suggestion.
  The reviewer chooses a `candidateId`.
- **Tier 3-4 only:** suggested only when every address on file is the same
  one. Several different addresses give no suggestion
  (`evidence.requiresManualConfirmation: true`), because one customer can
  have several delivery addresses.
- **No usable candidate:** `REQUEST_ADDRESS`. Ask the customer; nothing is
  ever invented.

A phone match identifies a possible customer relationship only. It never
makes an address the automatic choice when the customer has more than one.

## Duplicate invoices

Each scanned invoice is compared with invoices that share its invoice number,
`sourceOrderId`, `sourceQuotationId`, normalized phone, or linked-order
payment transaction (`compareInvoices`).

| Signal                | Weight | Source                                                                                                         |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| `sameInvoiceNo`       | 0.50   | identical non-empty `invoiceNo`                                                                                |
| `sameSourceOrder`     | 0.45   | same `sourceOrderId`                                                                                           |
| `sameSourceQuotation` | 0.45   | same `sourceQuotationId` (only between documents of the same kind)                                             |
| `sameTransactionRef`  | 0.40   | both invoices' `sourceOrderId` orders (`AquaOrder`) have the same non-empty `transactionId`                    |
| `samePhone`           | 0.10   | same normalized mobile                                                                                         |
| `sameProducts`        | 0.15   | identical lines (product id, or normalized name, and quantity)                                                 |
| `sameTotal`           | 0.10   | identical total from the existing `getInvoiceProductPriceTotal` (summed `productPrice`, as reports use)        |
| `withinWindow`        | 0.15   | invoice dates (`parseInvoicePurchaseDate` of `invoice.date`) at most `MCP_INVOICE_DUPLICATE_WINDOW_DAYS` apart |

- **When a pair is flagged:** only with one of the first four (strong) signals,
  or with the full combination of phone + identical lines + identical
  total + dates within the window.
  - Same customer and amount alone is treated as a repeat purchase and not
    flagged.
  - The window uses the invoice's own `date`, never `createdAt`. A missing
    or unparseable date never satisfies it.
- **Confidence** is the sum of the weights of the signals present, capped at
  0.99. The signals are listed in `confidenceBasis`.
- **Payment reference** is read **only** from `AquaOrder.transactionId` of the
  invoice's linked order.
  - `AquaInvoice` has no payment-reference field.
  - CRM payment links (`AquaPayment`) are not used: their `invoiceId` is a
    free-form string the CRM client sends, so it is not a reliable link.
- **What you get:** a `REVIEW_DUPLICATE_INVOICE` suggestion with
  `primaryInvoiceId` (earlier invoice date) and `suspectedDuplicateId`, plus
  `suggestedAction: "REVIEW_FOR_RECONCILIATION"`.
  - It is never executable: executing it returns `MANUAL_REVIEW_REQUIRED`
    with a manual accounting-review recommendation.
  - Dismiss a false match with `aquakart_ignore_invoice_action`.

## Suggested actions

Fields (`aquakart_get_invoice_action` returns all of them):

- **Identity and status:** `actionId` (`ina_…`), `type`, `status`, `field`,
  `expectedRevision` (the invoice's `updatedAt` at scan time).
- **Invoices:** `invoiceId`, `relatedInvoiceIds`, `primaryInvoiceId` /
  `suspectedDuplicateId`.
- **Address suggestion:** `currentValue`, `suggestedValue`,
  `suggestedCandidateId`, `candidates[]` (`candidateId`, `source`, `value`,
  `confidence`, `reference`).
- **Reasoning:** `evidence`, `confidence`, `confidenceBasis`.
- **Flags:** `requiresApproval` (always true), `executable`.
- **Outcome:** `execution` (`before`, `after`, approver note, operation id),
  `ignored`, `history[]`.
- **Live state:** `currentState`, with each invoice's current revision and
  `wouldBeStale`.

Phone numbers are masked (`98******10`) in every result and are never stored
on the action. `customerKey` is a SHA-256 of the normalized number, used only
for the `customerPhone` filter. Addresses are returned to the authorized
reviewer only and are never written to logs.

**Statuses:**

| Status           | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `pending_review` | created or refreshed by a scan                                                |
| `approved`       | recorded in history when an approved execution starts                         |
| `executing`      | claimed by one execution; others get `OPERATION_IN_PROGRESS`                  |
| `executed`       | address filled; `execution.before/after` and an audit log entry exist         |
| `ignored`        | dismissed; later scans keep it ignored                                        |
| `failed`         | saving failed; retry with the same `idempotencyKey`, or a new scan reopens it |
| `stale`          | the invoice or its evidence changed; a new scan reopens it for review         |

**Re-scans.** `issueKey` is a SHA-256 of type + invoice ids + field, under a
unique index.

- `pending_review` suggestions are refreshed.
- `stale` and `failed` ones are reopened.
- `executed` and `ignored` ones are left unchanged.
- An open address suggestion for an invoice that now has an address becomes
  `stale`.

## Executing a suggestion

`aquakart_execute_invoice_action` needs:

- `idempotencyKey`
- `actionId`
- `expectedRevision` (from the reviewed action)
- `approval: { confirmed: true, note }`
- optionally `candidateId` (required when there is no single suggestion)

The server then:

1. Refuses anything that isn't a `FILL_MISSING_ADDRESS` (`MANUAL_REVIEW_REQUIRED`),
   ignored (`ACTION_NOT_EXECUTABLE`), already `stale` (`ACTION_STALE`) or
   has a wrong `expectedRevision` (`REVISION_CONFLICT`). An `executed` action
   returns `alreadyExecuted: true`.
2. Claims the action atomically (`executing`, lock
   `MCP_INVOICE_EXECUTION_LOCK_SECONDS`).
3. Re-reads the invoice and re-checks three things. Any failure marks the
   action `stale` and returns `ACTION_STALE`.
   - Its revision is unchanged.
   - The address is still missing.
   - The chosen address is still backed by the same evidence.
4. Writes `customerDetails.address` with one conditional update on the
   invoice's `updatedAt`. A concurrent CRM edit makes the update match
   nothing, so it is never overwritten. No multi-document transaction is
   needed or used.
5. Marks the action `executed` and writes an `AquaAuditLog` entry
   (`mcp.invoice.fill_address`, `before`/`after` address, approval note,
   operation and correlation ids).

A retry after a crash between steps 4 and 5 finds the invoice already holding
the chosen address and finishes the action. The same `idempotencyKey`
replays the stored result.

`aquakart_ignore_invoice_action` (`reason` required) sets `ignored` and writes
`mcp.invoice.ignore_action`. It never touches the invoice.

## Error codes

`VALIDATION_FAILED`, `RANGE_TOO_LARGE`, `INVOICE_ACTION_NOT_FOUND`,
`MANUAL_REVIEW_REQUIRED`, `ACTION_NOT_EXECUTABLE`, `ACTION_STALE`,
`ACTION_ALREADY_EXECUTED`, `REVISION_CONFLICT`, `CANDIDATE_REQUIRED`,
`OPERATION_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`, `STORAGE_UNAVAILABLE`,
`INSUFFICIENT_SCOPE`, `INTERNAL_ERROR`.

## Database

- **New collection** `aquamcpinvoiceactions` (model `AquaMcpInvoiceAction`), with
  these indexes:
  - unique `actionId` and unique `issueKey`
  - `{status, type, createdAt}`, `{invoiceId, createdAt}`
  - `relatedInvoiceIds`, `customerKey`, `invoiceDate`
- **New non-unique index** `{ invoiceNo: 1 }` on `AquaInvoice`, for the
  duplicate check. Mongoose builds missing indexes when the app starts.
- **Writes for every execution and dismissal:** the existing `AquaMcpOperation`
  ledger (30-day retention) and `AquaAuditLog`.

## Limitations

- Invoices without `customerPhoneNormalized` (records saved before that field
  existed and never re-saved) are matched only on invoice number, order,
  quotation and transaction references, not on phone.
- The scan range filters on record creation time (`createdAt`). Duplicate
  timing uses invoice dates.
- There is no review screen in the CRM yet. Review happens through the MCP
  tools.

## Deployment and verification

1. Merge, then deploy through the existing Jenkins/Ubuntu pipeline. No new
   dependency. The optional `MCP_INVOICE_*` variables can go in `.env` or
   `aqua-env`; settings are read at startup.
2. After deploy, check the startup log for index build errors (new collection
   and the `invoiceNo` index).
3. In CRM Access Control, give `invoices.audit` (and, for approvers,
   `invoices.audit.execute`) to the right role. Super-admins already have
   both.
4. Reconnect the MCP client and tick `invoices:audit` (and `invoices:actions`
   if approving).
5. Verify read-only first: `aquakart_audit_invoices` with `dryRun: true` and a
   short range. Then run a saved scan and review with
   `aquakart_get_invoice_action`. Execute one reviewed suggestion and check
   `aquakart_get_invoice_audit_history` and the CRM invoice.
