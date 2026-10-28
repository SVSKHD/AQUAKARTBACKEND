# Backend project map

Verified against local source: 2026-10-25 (Asia/Calcutta). This is a focused
navigation map, not an exhaustive endpoint inventory. Check the mounted route
and controller for the current contract.

## Runtime and boundaries

- `index.js`: loads configuration, connects MongoDB, starts the scheduler,
  configures Cloudinary, listens on `PORT` (default 5300), and generates Swagger.
- `app.js`: constructs Express, configures middleware/CORS/proxy handling,
  mounts routers, and serves Swagger UI at `/v1/api-docs`.
- `config.js`: loads `.env` unless `DOPPLER_PROJECT` is set.
- `src/utils/db.js`: MongoDB connection. Models are under `src/models/` and
  `src/models/crm/`; do not assume a route module name equals its model name.
- `src/routes/` and `src/controllers/`: storefront/public APIs.
  Their `crm/` subfolders implement CRM/admin domains, but exact URL prefixes
  are determined by `app.js`.
- `src/services/`: shared business/integration logic; `src/utils/`: helpers;
  `src/jobs/`: scheduled business jobs; `test/`: Node test-runner suites.
- `src/scripts/`: explicit generation/seed tools. Seed scripts write data.
- `AQUAKARTECOM` and `AQUACRM25DEV` are separate sibling frontend repositories.
  `/aqua` product artifact UI lives in the storefront, not this backend.

## Find the relevant module

Paths below are relative to the repository root. For a specific feature, read
the named route/controller first and follow its imports rather than listing
the whole repository.

| Area / mounted prefix                                                                        | Entry points                                                                                                                                                                                                                                          | Related guide or focused checks                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer auth: `/v1`                                                                         | `src/routes/user.js`, `src/controllers/user.js`; `src/routes/googleAuth.js`, `src/controllers/googleAuth.js`; `src/config/firebaseAdmin.js`, `src/middleware/googleSession.js`, `src/middleware/firebaseAuth.js`                                      | [Google auth](AUTH_GOOGLE_FIREBASE.md); `test/googleSessionMiddleware.test.js`                                                                                                                                                                                                   |
| Staff auth and access: `/v1/crm/user`, `/v1/admin`                                           | `src/routes/crm/adminUser.js`, `src/routes/crm/accessControl.js`; `src/middleware/user.js`, `src/middleware/permissions.js`, `src/constants/permissions.js`                                                                                           | Follow the mounted router and permission middleware                                                                                                                                                                                                                              |
| Products: `/v1`                                                                              | `src/routes/product.js`, `src/controllers/product.js`, `src/models/product.js`, `src/utils/productReferences.js`                                                                                                                                      | `test/productReferences.test.js`; product updates accept populated references with `_id` as well as IDs                                                                                                                                                                          |
| Categories/subcategories: `/v1`                                                              | `src/routes/category.js`, `src/routes/sub-category.js`; matching controller/model files; `src/docs/categories.js`                                                                                                                                     | Category photos use multipart uploads; subcategory photos use JSON URLs/data URIs. Check controller before changing either                                                                                                                                                       |
| Blogs and SEO: `/v1`, `/v1/seo`, `/v1/admin/seo`                                             | `src/routes/blog.js`, `src/controllers/blog.js`, `src/routes/seo.js`, `src/services/seoReadiness.js`, `src/routes/crm/seo.js`                                                                                                                         | `test/seo.test.js`; automated jobs in `src/jobs/aiBlogDrafts.js`, `src/jobs/aiSeoRefresh.js`                                                                                                                                                                                     |
| Checkout/payments/referrals: `/v1/checkout`, `/v1/payments`, `/v1/referrals`, admin variants | `src/routes/checkout.js`, `src/routes/payments.js`, `src/routes/referrals.js`; `src/services/checkout.js`, `src/services/gateways/`, `src/services/coupons.js`, `src/services/referrals.js`                                                           | [Commerce API](COMMERCE_PLATFORM_API.md); `test/commercePlatform.test.js`                                                                                                                                                                                                        |
| Legacy orders/PhonePe: `/v1`                                                                 | `src/routes/orders.js`, `src/routes/phonepegatway.js`, `src/controllers/order.js`, `src/controllers/phonepeGateway.js`                                                                                                                                | Separate legacy flows from the checkout service; follow callers before editing                                                                                                                                                                                                   |
| CRM invoices/payment links: `/v1/crm`                                                        | `src/routes/crm/invoice.js`, `src/controllers/crm/invoice.js`, `src/controllers/crm/invoiceDelivery.js`, `src/routes/crm/paymentLink.js`; `src/services/invoiceSharing/`                                                                              | `test/invoiceViews.test.js`, `test/invoiceAutomation.test.js`, `test/invoiceEmailTemplate.test.js`                                                                                                                                                                               |
| Public invoice access: `/v1/invoices/public`                                                 | `src/routes/publicInvoice.js`, `src/controllers/publicInvoice.js`, `src/middleware/invoiceAccess.js`, `src/utils/invoiceAccess.js`                                                                                                                    | `test/invoiceAccess.test.js`, `test/invoiceAccessMiddleware.test.js`, `test/myInvoices.test.js`                                                                                                                                                                                  |
| Invoice reports: `/v1/invoices/report`                                                       | `src/routes/invoiceReports.js`, `src/services/invoiceReports.js`                                                                                                                                                                                      | [Invoice reports](INVOICE_REPORTS.md); `test/invoiceReports.test.js`, `test/invoiceReportRoute.test.js`                                                                                                                                                                          |
| Quotations: `/v1/crm/quotations`                                                             | `src/routes/crm/quotation.js`, `src/controllers/crm/quotation.js`, `src/services/quotation/`, `src/jobs/quotationFollowups.js`                                                                                                                        | Follow quotation service imports for delivery and conversion behavior                                                                                                                                                                                                            |
| CRM sales/customer records                                                                   | `src/routes/crm/customer.js`, `customerProfile.js`, `lead.js`, `activity.js`, `deal.js`, `order.js`, `ecommerceOrders.js`, `stock.js`; corresponding controllers                                                                                      | Prefixes: `/v1/crm/customers`, `/customer-profiles`, `/leads`, `/activities`, `/deals`, `/orders`, `/ecom-orders`; stock router mounts at `/v1/crm`. `test/crmSalesFoundation.test.js`                                                                                           |
| Notifications/WhatsApp/email                                                                 | `src/services/notifications/`, `src/services/crmNotifications.js`, `src/utils/sendEmail.js`, `src/utils/sendWhatsApp.js`, `src/routes/crm/whatsapp.js`, `src/routes/whatsappMetaWebhook.js`                                                           | [Fast2SMS](FAST2SMS_WHATSAPP.md); `test/sendEmail.test.js`, `test/fast2SmsWhatsApp.test.js`, `test/crmNotifications.test.js`                                                                                                                                                     |
| AI: `/v1/ai`, `/v1/crm/ai`                                                                   | `src/routes/ai.js`, `src/controllers/ai.js`, `src/models/aiChatSession.js`; `src/routes/crm/ai.js`, `src/controllers/crm/aiInvoice.js`; `src/services/gemini.js`, `src/services/aiCatalogue.js`, `src/services/aiQuota.js`, `src/services/aiInvoice/` | `test/gemini.test.js`, `test/aiCatalogue.test.js`, `test/aiQuota.test.js`, `test/aiInvoiceDraft.test.js`; inspect working changes before editing chat behavior                                                                                                                   |
| Jobs: `/v1/crm/jobs`; service reminders: `/v1/service-reminders`                             | `src/services/scheduler/index.js`, `actions.js`, `schedule.js`; `src/routes/crm/scheduledJobs.js`; `src/jobs/`, `src/services/serviceReminders.js`                                                                                                    | [Service reminders](PRODUCT_SERVICE_REMINDERS.md); `test/scheduler.test.js`, `test/serviceReminders.test.js`                                                                                                                                                                     |
| Analytics/storefront/merchant feed                                                           | `src/routes/analytics.js`, `src/routes/storefront.js`, `src/routes/merchantFeed.js`                                                                                                                                                                   | Mounted at `/v1/analytics`, `/v1/storefront`, `/v1/merchant`; follow controller imports. Public `GET /v1/storefront/recent-purchases` (anonymous invoice demand feed) uses `src/services/storefrontDemand.js`, docs in `src/docs/storefront.js`; `test/storefrontDemand.test.js` |
| Swagger                                                                                      | `swagger-autogen.js`, `src/scripts/generate-swagger.js`, `src/docs/routeGroups.js`, `src/docs/categories.js`                                                                                                                                          | `npm run swagger`; `test/routeGroups.test.js`; grouping follows mounted route folders/modules                                                                                                                                                                                    |

## Commands and deployment

| Purpose                     | Command / location                                                        |
| --------------------------- | ------------------------------------------------------------------------- |
| Install locked dependencies | `npm ci`                                                                  |
| Development startup         | `npm start` (`nodemon`; starts integrations/jobs)                         |
| Direct runtime              | `node index.js`                                                           |
| Focused tests               | `node --test test/<name>.test.js`                                         |
| Full suite                  | `npm test`                                                                |
| Syntax check                | `node --check src/<changed-file>.js`                                      |
| Lint                        | `npm run lint` (existing Airbnb rules; distinguish pre-existing failures) |
| Regenerate Swagger          | `npm run swagger`                                                         |
| Container build             | `docker build -t aquakartbackend:local .` when Docker is available        |

`Dockerfile` uses Node 22 Alpine, production dependencies with lifecycle scripts
disabled, and PM2 runtime. `package-lock.json` is the npm/Docker lockfile.
ESLint is pinned to 8.57.1 for compatibility with Airbnb 15 and import plugin 2.
Local ignored pnpm/yarn lockfiles are not the Docker install contract.
`.dockerignore` excludes local dependencies, caches, `.env` files, and credential
JSON. Supply Firebase credentials through deployment configuration/mounts;
check `src/config/firebaseAdmin.js` for file-based versus inline settings.

## Keeping this map current

Customer AI editorial workflow (added 2026-10-26): `/v1/crm/ai/users` is routed
through `src/routes/crm/ai.js`, with `src/controllers/crm/aiUsers.js`,
`src/services/crm/customerAi.js`, `src/docs/crmCustomerAi.js`, and
`test/crmCustomerAi.test.js`. See [CRM customer AI](CRM_CUSTOMER_AI.md) for
directory/transcript access, required permissions and draft-blog generation.
This reuses storefront customer chats and adds hidden provenance to the existing
blog model; it does not expose other staff members' private CRM chats.

CRM AI conversation entry points: `src/controllers/crm/aiChats.js`,
`src/services/crm/aiChats.js`, `src/models/crm/aiChat.js`, and
`src/docs/crmAi.js`. See [CRM AI chats](CRM_AI_CHATS.md) for the API contract and
`test/crmAiChats.test.js` for ownership, pinning, persistence, and streaming tests.
Generation continues through `src/controllers/ai.js` at `/v1/crm/ai/generate`
and `/v1/crm/ai/generate/stream`; saved chats use `/v1/crm/ai/chats`.

Update the affected row when a module, prefix, guide, test entry point, command,
or runtime requirement changes. Record the task separately in
[CHANGELOG.md](CHANGELOG.md); do not turn this map into a chronological log.
