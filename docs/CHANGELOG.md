# Agent change log

Dates use Asia/Calcutta. Newest dates first; append task entries within the
current date. This log begins on 2026-10-25; earlier work is not backdated.

Use this format for every task that changes code, configuration, dependencies,
tests, or docs:

```markdown
## YYYY-MM-DD

### Short task title

- Request/problem: ...
- Changes/result: ...
- Files: `path/to/file`, ...
- Validation: exact commands and outcomes; distinguish dry runs from live checks.
- Limitations/follow-up: ... (or None).
```

## 2026-10-29

### Return saved addresses with the signed-in account

- Request/problem: Addresses saved to the account never came back to the
  storefront after signing in again or on another device. `safeUser()` omitted
  them. `POST /user/update-details/:id` also let any signed-in user update any
  account, including `role`.
- Changes/result: (Made by the AQUAKARTECOM storefront session; reviewed here,
  then hardened in the next entry.) `safeUser()` now returns `dob`, `addresses`
  and `selectedAddress` for `POST /auth/google` and `GET /auth/me`.
  `update-details` accepts only the caller's own id (else 403) and no longer
  returns the password hash.
- Files: `src/controllers/googleAuth.js`, `src/controllers/user.js`,
  `test/userAccountDetails.test.js`.
- Validation: covered by the unit tests in the next entry. Not tried in a
  browser or against a live database.
- Limitations/follow-up: The storefront reloads the account from `/auth/me`, so
  this backend must be deployed before the storefront change shows addresses.

### Restrict profile updates to safe fields and stop phone-based reminder lookups

- Request/problem: The protected-field blocklist from the entry above still
  let shoppers set OTP and sign-in fields and dotted paths such as
  `invoices.0.invoiceId`, and email edits were silently ignored. Separately,
  `GET /service-reminders/mine` matched invoices by the profile phone (editable
  without verification) and by unverified email, so a shopper could set another
  customer's phone and see that customer's purchases.
- Changes/result: `update-details` now saves only an allowlist (`firstName`,
  `lastName`, `phone`, `dob`, `alternativeEmail`, `photo`, `gstDetails`,
  `addresses`, `selectedAddress`) and runs schema validators. A changed email
  returns 400 with a message (resending the current email is still accepted).
  An empty phone is `$unset` instead of stored as null. Duplicate phone returns
  409, and validation/cast errors return 400. Service reminders now use the
  same ownership rule as `/invoices/public/mine`: Firebase UID, or unclaimed
  invoices with the Google-verified email. The phone is no longer used.
- Files: `src/controllers/user.js`, `src/controllers/serviceReminders.js`,
  `test/userAccountDetails.test.js`, `test/serviceRemindersOwnership.test.js`,
  `docs/AUTH_GOOGLE_FIREBASE.md`, `docs/PRODUCT_SERVICE_REMINDERS.md`,
  `swagger-output.json`.
- Validation: `node --check` on both controllers passed;
  `node --test test/userAccountDetails.test.js test/serviceRemindersOwnership.test.js test/serviceReminders.test.js`
  passed 14/14 (mocked Mongoose). `npm run swagger` succeeded;
  `/v1/user/update-details/{id}` lists 200/400/401/403/409/500. Full
  `node --test`: 161/162 passed; the failure is the same `invoiceViews` test that
  already failed before these changes. Not run against a live database.
- Limitations/follow-up: Older storefront pages
  (`pageComponents/userDasboard/profle.js`, `pageComponents/checkout/index.js`)
  still show an editable email field and will now get the 400 if it is changed.
  Customers whose invoices match only by phone (no Google account bound and no
  verified email match) no longer see service reminders until the invoice is
  claimed. The unrouted `updateIdentifierDetails` in `src/controllers/user.js`
  is unsafe if it is ever mounted.

### Save the installation slot chosen at checkout

- Request/problem: The storefront asks for an installation day and slot at
  checkout, but the backend never received or stored it.
- Changes/result: (Made by another agent session; reviewed here, not modified.)
  Orders have an `installation: { day, slot }` field. Both
  `POST /checkout/orders/cod` and `POST /payments` read `req.body.installation`
  through `installationFrom()`, which keeps a `YYYY-MM-DD` day and a slot of up
  to 40 characters, and drops anything malformed without failing the order.
  Documented in `docs/COMMERCE_PLATFORM_API.md`.
- Files: `src/models/orders.js`, `src/services/checkout.js`,
  `src/controllers/checkout.js`, `src/controllers/payments.js`,
  `test/checkoutInstallation.test.js`, `docs/COMMERCE_PLATFORM_API.md`.
- Validation: `node --test test/checkoutInstallation.test.js` passed 2/2. Also
  covered by the full run above. Not tried with a real order.
- Limitations/follow-up: The day is only format-checked, so past dates or
  impossible dates such as `2026-02-31` are accepted. There is no
  requested/confirmed status. The CRM order screens and new-order notifications
  do not show the slot yet. The storefront must send `installation` with both
  order requests.

## 2026-10-28

### Public recent-purchases demand feed from invoices

- Request/problem: The e-commerce store needs to show the latest purchases
  from the shopper's area so customers can see which products are in demand.
- Changes/result: Added public `GET /v1/storefront/recent-purchases` with
  optional `area` (literal, case-insensitive address match, max 60 chars),
  `limit` (1-20, default 10) and `days` (1-90, default 30, by invoice
  `createdAt`). Quotations are excluded. It returns `recent` purchase lines (product
  name/slug/id, quantity, locality picked from the free-text address or the
  requested area, time rounded down to the hour) and `trending`: top 5
  products by invoice count, plus units. Only address, products and createdAt
  are selected; names, phones, emails, invoice numbers and full addresses never
  leave the service. Responses are cacheable (60s, CDN 300s). Added an explicit
  Swagger contract in the Storefront group.
- Files: `src/services/storefrontDemand.js`,
  `src/controllers/storefrontStats.js`, `src/routes/storefront.js`,
  `src/docs/storefront.js`, `app.js`, `swagger-autogen.js`,
  `swagger-output.json`, `test/storefrontDemand.test.js`,
  `docs/PROJECT_MAP.md`.
- Validation: `node --check` on each changed JS file passed;
  `node --test test/storefrontDemand.test.js` passed 4/4 (unit tests with
  mocked Mongoose, no database). `npm run swagger` succeeded and the
  generated operation has the Storefront tag, the `area`/`limit`/`days` params
  and 200/500 responses. Full `node --test`: 150/151 passed; the failure
  (`test/invoiceViews.test.js` "builds separate admin and customer invoice
  destinations from one id") also fails with this change stashed, so it was
  already failing. Not run against a live database.
- Limitations/follow-up: Locality extraction is a heuristic over free-text
  addresses (last comma/line segment that isn't the city, state, PIN or a house line;
  falls back to Hyderabad/Secunderabad or null). The `area` filter is an
  unindexed regex within the date window. Paid status is not filtered,
  matching `/v1/storefront/stats`. Migrated invoices may carry migration-time
  `createdAt` values. `swagger-output.json` already had uncommitted changes
  before this regeneration. The storefront UI does not use the feed yet.

## 2026-10-26

### CRM customer AI review and Q/A-to-blog draft workflow

- Request/problem: CRM needs a customer user view with their AI questions and
  answers so editors can create blog articles from real conversations.
- Changes/result: Added a safe, paginated customer directory with chat statistics,
  customer-owned transcript/Q/A lookup, source-linked article listing, and
  selected-question blog generation. Added customers.read, ai.chats.read and
  blogs.manage scopes; existing administrators retain access. Reused current
  customer profile management and blog editing rather than creating duplicate
  account or publishing systems. Generation redacts known/common personal details,
  restricts HTML, validates output, stores an unpublished draft, records hidden
  source IDs and writes an audit event. Public blog-by-ID access now excludes
  drafts; explicit administrator status=draft/all reads remain available.
- Files: `src/constants/permissions.js`, `src/models/blog.js`,
  `src/controllers/crm/aiUsers.js`, `src/services/crm/customerAi.js`,
  `src/routes/crm/ai.js`, `src/controllers/blog.js`, `src/routes/blog.js`,
  `src/docs/crmCustomerAi.js`, `app.js`, `swagger-autogen.js`,
  `swagger-output.json`, `test/crmCustomerAi.test.js`,
  `test/crmCustomerAiDocs.test.js`, `docs/CRM_CUSTOMER_AI.md`,
  `docs/README.md`, `docs/PROJECT_MAP.md`, `docs/CHANGELOG.md`.
- Validation: `node --test test/crmCustomerAi.test.js test/crmCustomerAiDocs.test.js test/aiBlogDrafts.test.js test/crmAiChats.test.js test/crmAiDocs.test.js test/crmSalesFoundation.test.js test/routeGroups.test.js`
  passed all 41 tests, including mocked AI/storage behavior and Swagger schema
  validation. Ran with sandbox escalation because installed dependency files
  were inaccessible in the sandbox. `npm.cmd run swagger` succeeded with the
  same dependency-read escalation. Syntax checks passed for changed runtime
  modules; checked the six generated customer editorial operations for their
  CRM / AI group and staff security and verified documentation links.
- Limitations/follow-up: No live database/provider or browser end-to-end test.
  The separate CRM frontend needs its user directory, transcript selection and
  Create blog actions wired to these endpoints. No guest/trimmed history recovery;
  manual fact/privacy review remains necessary. Each POST creates a new draft;
  callers must prevent repeated clicks. Existing unrelated edits were preserved.

## 2026-10-25

### Add backend agent navigation and documentation maintenance rules

- Request/problem: Agents need a clear backend overview without repeatedly
  scanning the entire repository, plus dated records after LLM changes.
- Changes/result: Added repository-wide agent instructions, a domain-based source
  map, a documentation index, and this task log. Required scoped discovery,
  accurate validation reporting, API documentation maintenance, and same-task
  updates to the dated log. Linked the entry points from the backend README.
- Files: `AGENTS.md`, `docs/README.md`, `docs/PROJECT_MAP.md`,
  `docs/CHANGELOG.md`, `readme.md`.
- Validation: Reviewed mapped paths against local source, route mounts in
  `app.js`, startup behavior in `index.js`, package scripts, and Docker setup.
  A Node filesystem/assertion check verified 24 local Markdown links and 111
  explicitly referenced source/test paths; all passed.
- Limitations/follow-up: Documentation-only change; application tests and live
  integrations were not run. Existing AI chat, coupon, and generated Swagger edits were
  left untouched. Future dated entries depend on agents following `AGENTS.md`;
  no automatic watcher was installed.

### Persist private CRM AI conversations with history and pinning

- Request/problem: General CRM AI generation had no saved conversation list,
  server-loaded history, or chat management for staff.
- Changes/result: Added staff-owned chats with create/list/read/rename/pin/unpin/
  archive/restore/delete endpoints. Both generation variants return sessionId
  after saving completed turns; continuation uses owned server history. Added
  pinned-first pagination, literal title search, input validation, bounded message
  retention, and optimistic conflict detection for concurrent sends or deletion.
  Storefront chats and invoice assistant sessions remain separate. Added explicit
  Swagger contracts and a CRM API integration guide.
- Files: `src/models/crm/aiChat.js`, `src/services/crm/aiChats.js`,
  `src/controllers/crm/aiChats.js`, `src/routes/crm/ai.js`,
  `src/controllers/ai.js`, `src/docs/crmAi.js`, `app.js`, `swagger-autogen.js`,
  `swagger-output.json`, `test/crmAiChats.test.js`, `test/crmAiDocs.test.js`,
  `docs/CRM_AI_CHATS.md`, `docs/README.md`, `docs/PROJECT_MAP.md`, `docs/CHANGELOG.md`.
- Validation: `node --test test/crmAiChats.test.js test/crmAiDocs.test.js test/aiChatUpdate.test.js test/gemini.test.js test/aiInvoiceDraft.test.js test/routeGroups.test.js`;
  29 tests passed, including mocked generation/SSE persistence, ownership,
  pin/unpin, search/pagination, archive rejection, failure handling, concurrent
  append conflicts, and Swagger 2 schema validation. `node --check` passed for
  changed runtime modules. `npm.cmd run swagger` succeeded; checked seven CRM
  chat/generation operations for the CRM / AI group and staff token security.
- Limitations/follow-up: No live MongoDB/AI-provider or frontend end-to-end check.
  Only the latest 200 messages are retained; generation uses the last 30. Old
  stateless CRM chats have no server history to migrate. The separate CRM frontend
  still needs to connect its conversation sidebar/actions to these APIs. Existing
  unrelated working changes were preserved.
