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

## 2026-11-06

### MCP: product and coupon tools; error results without structuredContent

- Request/problem: add products read/add and coupons read/add to the MCP
  server. While testing with the SDK client, a separate problem turned up.
  Every MCP error result included `structuredContent` that didn't match
  the tool's output schema. SDK-based clients reject such results, so the
  real error code (for example `INSUFFICIENT_SCOPE`) never reached them.
- Changes/result:
  - **New tools:** `aquakart_list_products`, `aquakart_get_product`
    (`products:read`); `aquakart_create_product` (`products:write`);
    `aquakart_list_coupons`, `aquakart_get_coupon` (`coupons:read`);
    `aquakart_create_coupon` (`coupons:write`).
  - **Permissions:** new CRM permissions `products.read` and
    `products.manage`, assigned to no role. Only super-admin and role 1 have
    them, matching the admin-only CRM product routes. Coupon scopes use the
    existing `coupons.read` and `coupons.manage`. `products:write` and
    `coupons:write` start unticked on the consent page.
  - **Read limits:** product reads never return `dpPrice`, reviews or
    reviewer/customer ids. Coupon reads give `targetedAccounts` (a count)
    instead of customer ids.
  - **Product creation:** products go live immediately, because the model
    has no draft state. New products get `merchantEnabled: false` by
    default. Photos come from `aquakart_upload_image` media ids. The
    description is sanitized. Duplicate titles and SKUs are refused.
  - **Coupon creation:** coupons are drafts unless `status: "active"` is
    passed. Codes are stored uppercase. Percentages are capped at 100,
    `endsAt` must be in the future, and product/category ids are checked.
    Coupons can't be targeted at customer accounts.
  - **Idempotency and audit:** both writes are idempotent and audited
    (`mcp.product.create`, `mcp.coupon.create`). A hidden `mcpOperation`
    field (`select: false`) on `AquaProduct` and `AquaCoupon` lets a retry
    after a crash return the saved record instead of creating a duplicate.
  - **Shared images:** replacing a blog title image no longer deletes an
    MCP-uploaded image that a product uses.
  - **Error results:** they now carry the JSON only in `content[0].text`,
    with no `structuredContent`. Success results are unchanged.
- Files: `src/services/mcp/catalogTools.js` (new),
  `src/services/mcp/server.js`, `src/services/mcp/store.js`,
  `src/services/mcp/config.js`, `src/services/mcp/consentPage.js`,
  `src/services/mcp/oauthProvider.js`, `src/services/mcp/index.js`,
  `src/routes/mcp.js`, `src/constants/permissions.js`,
  `src/models/product.js`, `src/models/coupon.js`, `src/docs/mcp.js`,
  `swagger-output.json`, `test/mcpCatalogTools.test.js` (new),
  `test/mcpServer.test.js`, `docs/MCP_BLOG_PUBLISHING.md`,
  `docs/PROJECT_MAP.md`, `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed on every changed source file.
  - `node --test test/mcpCatalogTools.test.js test/mcpServer.test.js
test/mcpBlogTools.test.js test/mcpInstagram.test.js
test/blogRoutesRegression.test.js`: 46/46 passed. The new file runs 9
    tests, including a real SDK `Client` over `InMemoryTransport` that
    checks scope enforcement and error results.
  - Full `node --test`: 217/218 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` invoice-destination test.
  - `npm run swagger` succeeded, then Prettier ran on `swagger-output.json`.
    Only the two MCP endpoint descriptions changed.
  - Unit tests and in-memory fakes only. I made no calls against MongoDB,
    Cloudinary or production, and created no products or coupons.
- Limitations/follow-up:
  - Not deployed.
  - **Reconnect:** existing connections must reconnect and tick the new
    scopes to use these tools.
  - **No edits through MCP:** there are no tools to update or delete
    products or to activate, pause or archive coupons; use the CRM.
  - **Image folder:** product photos added through MCP are stored under
    `Blogs/mcp_<hash>`, not `products/`.

### MCP: Aquakart logo on the consent page and logo references for AI images

- Request/problem: show the Aquakart logo on the MCP consent page. Give MCP
  clients (LLMs) the official logo files to use as references when they
  create images.
- Changes/result:
  - **Consent page:** shows the round badge logo provided by the user,
    white in dark mode and original otherwise. The CSP now allows images
    only from the logo's host (`res.cloudinary.com`).
  - **Brand tool:** new tool `aquakart_get_brand_assets` (no scope; any
    signed-in connection). It returns the clean PNGs (`logo_nt2v92.png`,
    `logo-white_rpvptt.png`) as `url` and the badge renditions as
    `previewUrl`. It also returns the usage rules (never redraw or
    recolour; original on light backgrounds, white on dark) and how to
    apply the exact logo with `applyBrandLogo`. The server `instructions`
    tell clients to call it before making branded images.
  - **Logo overlay:** the overlay logo now defaults to `logo_nt2v92` (and
    `logo-white_rpvptt` for `logoVariant: "white"`, a new
    `aquakart_attach_image` option). Before, `applyBrandLogo` returned
    `LOGO_NOT_CONFIGURED` until `AQUAKART_LOGO_PUBLIC_ID` was set.
    `AQUAKART_LOGO_PUBLIC_ID=none` turns overlays off.
  - **New optional env vars:** `AQUAKART_LOGO_WHITE_PUBLIC_ID`,
    `MCP_BRAND_LOGO_URL`, `MCP_BRAND_LOGO_WHITE_URL`,
    `MCP_CONSENT_LOGO_URL`, `MCP_CONSENT_LOGO_WHITE_URL`.
- Files: `src/services/mcp/config.js`, `src/services/mcp/consentPage.js`,
  `src/services/mcp/oauthProvider.js`, `src/services/mcp/blogTools.js`,
  `src/services/mcp/store.js`, `src/services/mcp/server.js`,
  `src/docs/mcp.js`, `swagger-output.json`, `.env.example`,
  `test/mcpBlogTools.test.js`, `test/mcpCatalogTools.test.js`,
  `test/mcpServer.test.js`, `docs/MCP_BLOG_PUBLISHING.md`,
  `docs/CHANGELOG.md`.
- Validation:
  - `curl` fetched all four logo URLs (two badges, two clean files): each
    returned 200 `image/png`.
  - `node --check` passed on the changed files.
  - MCP and blog regression tests: 49/49 passed. New tests cover the
    consent-page logo and CSP, the default and white overlay, and the
    brand tool over the SDK client.
  - Full `node --test`: 220/221 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` test.
  - `npm run swagger` succeeded, followed by Prettier; only the
    `/v1/mcp` description changed.
  - I did not check the consent page in a browser, and I did not run the
    overlay against Cloudinary.
- Limitations/follow-up:
  - Not deployed.
  - **Logo fidelity:** image models may still distort a reference logo;
    only the overlay guarantees the exact file.
  - **Instagram:** Instagram uploads have no overlay option yet.

### MCP: category, subcategory and page SEO tools (CRUD and readiness)

- Request/problem: add CRUD for categories, subcategories and page SEO to
  the MCP server, plus SEO for all pages.
- Changes/result:
  - **New tools (15):**
    - categories and subcategories: `aquakart_list/get/create/update/delete_category`
      and the same for `_subcategory`
    - page SEO: `aquakart_list_seo`, `aquakart_get_seo`,
      `aquakart_create_seo`, `aquakart_update_seo`
    - `aquakart_get_seo_readiness`, the existing CRM readiness report over
      every page (static, product, category, subcategory, blog)
  - **Scopes:** `categories:read` and `categories:write` map to
    `products.read` and `products.manage`, since the CRM category routes
    are admin-only. `seo:read` and `seo:write` map to `seo.read` and
    `seo.manage`. The write scopes start unticked on the consent page.
  - **Rules, matching the CRM:**
    - deletes are refused while subcategories or products use the record
      (`CATEGORY_IN_USE`, `SUBCATEGORY_IN_USE`)
    - a subcategory can't move to another category while products use it
    - category creation needs a photo
    - SEO validation reuses `buildSeoPayload`
    - SEO has no hard delete; `active: false` switches a page off
  - **Extras:**
    - Titles must be unique, since the storefront looks them up by title.
    - Renames return a URL-change warning.
    - Replaced photos are never deleted from Cloudinary.
    - Updates and deletes accept `expectedRevision`.
    - Writes are idempotent and audited (`mcp.category.*`,
      `mcp.subcategory.*`, `mcp.seo.*`).
    - A hidden `mcpOperation` field (`select: false`) on `AquaCategory`,
      `AquaSubCategory` and `AquaSeo` makes create retries crash-safe.
    - A blog's replaced title image is now also kept when a category or
      subcategory uses it.
- Files: `src/services/mcp/taxonomySeoTools.js` (new),
  `src/services/mcp/taxonomySeoSchemas.js` (new),
  `src/services/mcp/server.js`, `src/services/mcp/store.js`,
  `src/services/mcp/config.js`, `src/services/mcp/consentPage.js`,
  `src/services/mcp/oauthProvider.js`, `src/services/mcp/index.js`,
  `src/routes/mcp.js`, `src/models/category.js`,
  `src/models/sub-category.js`, `src/models/seo.js`, `src/docs/mcp.js`,
  `swagger-output.json`, `test/mcpTaxonomySeo.test.js` (new),
  `docs/MCP_BLOG_PUBLISHING.md`, `docs/PROJECT_MAP.md`,
  `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed on every changed file.
  - `node --test test/mcpTaxonomySeo.test.js`: 7/7 passed, including SDK
    `Client` over `InMemoryTransport`.
  - Full `node --test`: 227/228 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` test.
  - `npm run swagger` succeeded, followed by Prettier; only the MCP endpoint
    descriptions changed.
  - Fakes only: I ran nothing against MongoDB or Cloudinary, and the Mongo
    store queries and aggregation were not run against a real database.
- Limitations/follow-up:
  - Not deployed.
  - **Reconnect:** connections must reconnect and tick the new scopes.
  - **Stray photos:** photos replaced through MCP stay in Cloudinary.
  - **Readiness size:** the readiness report is capped at 200 pages per
    call.
  - **AI refresh:** the weekly AI SEO refresh can overwrite pages edited
    through MCP unless `aiLocked: true` is set.

## 2026-11-05

### Storefront voice questions: `POST /v1/ai/transcribe`

- Request/problem: The storefront mic relied on the browser's Web Speech API,
  which most browsers lack or block, so voice questions didn't work. The
  storefront now records audio itself and needs it turned into text.
- Changes/result: `transcribeAudio` in `src/services/gemini.js` sends the clip
  inline to Gemini (temperature 0, verbatim, keeps the spoken language; "no
  speech" comes back empty). `AIOperations.transcribe` accepts
  `{ audio: base64, mimeType }` (WebM/Ogg/MP4/MPEG/AAC/WAV, up to 1 MB,
  about a minute), returns `{ text }` cut to the caller's prompt limit, is not
  counted, and returns the usual `AI_DAILY_LIMIT` 429 once today's questions
  are used up. Route uses `optionalUserAuth`. Swagger regenerated.
- Files: `src/services/gemini.js`, `src/controllers/ai.js`, `src/routes/ai.js`,
  `test/aiTranscribe.test.js`, `swagger-output.json`, `docs/CHANGELOG.md`.
- Validation: `node --check` on the three source files;
  `node --test test/aiTranscribe.test.js test/gemini.test.js test/aiQuota.test.js test/aiChatUpdate.test.js test/routeGroups.test.js`
  passed (23/23); `npm run swagger` succeeded. Not run: a live Gemini call,
  `npm run lint` (the installed ESLint finds no flat config).
- Limitations/follow-up: Needs deploying before the storefront mic works
  against production. `swagger-output.json` also picked up regeneration
  changes from earlier route edits.

### Remote MCP server for ChatGPT/Claude: blog drafts, publishing, Instagram

- Request/problem: Let ChatGPT, Claude and other MCP clients read, draft,
  illustrate and publish Aquakart blogs, and post Instagram creatives through
  Meta's API using temporary Cloudinary storage. Images must be cleaned up
  only after verified publication. No backend cron job and no Aureon. The
  task first asked for an Aureon REST API; the user replaced it mid-task
  with the MCP brief, so that partial work was folded in or deleted, not
  shipped.
- Changes/result:
  - **MCP endpoint:** `POST /v1/mcp` (Streamable HTTP, stateless, official
    `@modelcontextprotocol/sdk` 1.32.2). It is off (503) until
    `MCP_PUBLIC_BASE_URL` is set.
  - **OAuth 2.1:** served at the API root via the SDK's `mcpAuthRouter`
    with a MongoDB-backed provider.
    - DCR is limited to allowlisted ChatGPT/Claude/loopback redirects.
      Clients are public PKCE clients, so no secrets are stored.
    - Staff sign in on a consent page; each scope needs `blogs.manage` or
      the new CRM permission `instagram.publish`.
    - Codes and tokens are stored hashed. Refresh tokens rotate, and reuse
      or code replay revokes the grant. Staff status and permissions are
      re-checked on every request.
    - `npm run mcp:grants` lists and revokes grants.
  - **Tools (13):** `aquakart_list_blogs`, `_get_blog`, `_get_blog_status`,
    `_create_blog`, `_update_blog`, `_upload_image`, `_attach_image`,
    `_publish_blog`, `_upload_instagram_image`, `_publish_instagram`,
    `_get_instagram_status`, `_list_instagram_posts` and
    `_cleanup_instagram_asset`. Each has strict zod input/output schemas,
    per-tool scopes with an OAuth step-up hint, structured error codes,
    idempotency keys (`AquaMcpOperation` ledger), audit log entries and JSON
    log lines with correlation ids.
  - **Blogs:** stored in the existing `AquaBlog` collection, always created
    as drafts. HTML goes through an allowlist (`sanitize-html`). Duplicate
    content, titles and slugs are rejected. Only drafts are edited, and
    images survive partial updates. Publish runs quality checks, is atomic,
    and repeating it changes nothing.
  - **Blog model additions:** `updatedAt` (set by an update hook),
    `publishedAt`, and a hidden `integration` block with a unique partial
    `contentHash` index. Existing CRM/storefront behaviour is unchanged.
  - **Images:** ChatGPT file params, downloaded over HTTPS only from trusted
    hosts and only to public IPs (checked at connect time), or base64.
    Formats are detected from the bytes. Images are de-duplicated by
    SHA-256. Branded headers overlay a stored Cloudinary logo.
  - **Instagram:**
    - Temp images live in `aquakart/instagram-temp/`, with a Meta Graph
      client (token sent only in a header).
    - The lifecycle state machine uses persisted publish attempts, bounded
      container polling and reconciliation of lost `media_publish`
      responses, so nothing is re-posted blindly.
    - A durable MongoDB-leased cleanup worker deletes only the recorded
      temp public id 30 minutes (configurable) after verified publication,
      with exponential backoff. Cloudinary `not found` counts as cleaned.
  - **Gemini job:** unchanged. The guide documents how to disable it in the
    CRM.
- Files: `app.js`, `index.js`, `swagger-autogen.js`, `package.json`,
  `package-lock.json`, `.env.example`, `src/routes/mcp.js`,
  `src/services/mcp/{config,errors,operations,imageInput,blogTools,instagramTools,instagramGraph,oauthProvider,consentPage,server,store,index}.js`,
  `src/models/mcp/{mcpOperation,mcpMedia,oauth,instagramAsset}.js`,
  `src/validators/mcp/blog.js`, `src/models/blog.js`,
  `src/controllers/blog.js` (exports `validateTaxonomy`),
  `src/constants/permissions.js`, `src/docs/mcp.js`,
  `src/docs/routeGroups.js`, `src/scripts/mcp-grants.js`,
  `swagger-output.json`, `test/mcpServer.test.js`,
  `test/mcpBlogTools.test.js`, `test/mcpInstagram.test.js`,
  `test/blogRoutesRegression.test.js`, `test/support/mcpFakes.js`,
  `docs/MCP_BLOG_PUBLISHING.md`, `docs/README.md`, `docs/PROJECT_MAP.md`,
  `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed on all changed/new source files.
  - The four new test files pass 37/37 in unit tests with in-memory fakes:
    an HTTP end-to-end OAuth/MCP flow over localhost plus mocked
    Cloudinary/Meta/MongoDB.
  - Full `node --test`: 208/209. The one failure,
    `test/invoiceViews.test.js` "builds separate admin and customer invoice
    destinations", also fails with this task's tracked changes stashed.
  - `npm run swagger` succeeded and adds MCP/OAuth operations under "MCP".
    No existing operation changed; the diff is mostly regeneration
    formatting.
  - Not run: the server against a database, a real ChatGPT/Claude
    connection, real Cloudinary uploads, real Meta calls, any publish, and
    `npm run lint` (no ESLint flat config).
- Limitations/follow-up:
  - **Unverified ChatGPT behaviour:** OpenAI docs don't confirm that
    unattended scheduled tasks can call a custom MCP connector, skip write
    approvals, or pass generated images as file params. Scheduled publishing
    is unverified until an end-to-end scheduled run is done.
  - **Defaults to confirm:** the ChatGPT `download_url` host (default
    `*.oaiusercontent.com`) and the Meta API version (default `v26.0`).
  - **Instagram token:** the long-lived token isn't refreshed
    automatically.
  - **Rate limits and lockfile:** rate limits are per instance, and
    `pnpm-lock.yaml` was not updated (npm lockfile only).
  - **Deployment:** the reverse proxy must forward the root OAuth paths.
    `instagram.publish` must be assigned to a role.

### Fix Docker `npm ci` failure: lockfile out of sync for npm 10

- Problem: Jenkins build #228 (commit `9c70320`) failed at `npm ci` with
  "Missing: gcp-metadata@7.0.1 / google-logging-utils@1.2.0 from lock file".
  `mongoose`'s nested `mongodb@7.7.0` declares an optional peer
  `gcp-metadata@^7.0.1`. The root copy is 9.2.2, which doesn't satisfy it. The
  lockfile was written with npm 11, which leaves that peer out. The image's
  npm 10.9.9 (`node:22-alpine`) requires it to be listed.
- Result: regenerated the lockfile with `npx npm@10.9.9 install
--package-lock-only --ignore-scripts`. It adds only
  `node_modules/mongoose/node_modules/gcp-metadata@7.0.1` and
  `.../google-logging-utils@1.2.0`, both marked optional peers. No
  `package.json` or dependency version changes.
- Files: `package-lock.json`, `docs/CHANGELOG.md`.
- Validation: on a scratch copy of `package.json` and `package-lock.json`,
  `npm ci --omit=dev --ignore-scripts` passed with npm 10.9.9 (398 packages)
  and with local npm 11.16.0 (396 packages). I did not run a Docker or
  Jenkins build.
- Follow-up: regenerate the lockfile with npm 10 (or pin the same npm
  version locally and in the Dockerfile). Otherwise a lockfile written by
  npm 11 can break the build again.

## 2026-11-01

### Raise signed-in AI chat limit to 10 and stop scheduler errors without a DB

- Request/problem: Signed-in storefront customers were limited to 5 AI
  questions per day. Separately, the scheduler looked like it was failing. A
  read-only check of `AquaScheduledJob`/`AquaScheduledJobRun` showed all five
  built-in jobs with `lastStatus: success` and `failureCount: 0`. The failures
  were local: Node's resolver intermittently returned `querySrv ESERVFAIL` /
  `queryTxt ESERVFAIL` for the Atlas SRV record, although Windows'
  `Resolve-DnsName` resolved it. Mongoose does not retry a failed first
  connect, and `startScheduler()` kept ticking every 30s. So every tick logged
  `Scheduler tick failed` (buffering timeout) until restart.
- Changes/result: The default `AI_USER_DAILY_LIMIT` is now 10 (guests stay at
  3). Both remain overridable by env, and the variables are now listed in
  `.env.example`. `mongooseConnect()` retries the first connection up to 10
  times, 15s apart. The scheduler loop skips ticks while
  `mongoose.connection.readyState !== 1`, logging one "paused" and one
  "resumed" line instead of an error every 30s.
- Files: `src/services/aiQuota.js`, `test/aiQuota.test.js`, `.env.example`,
  `src/utils/db.js`, `src/services/scheduler/index.js`, `docs/CHANGELOG.md`.
- Validation: `node --check` on the three changed source files passed;
  `node --test test/aiQuota.test.js test/scheduler.test.js test/userRoles.test.js`
  passed 19/19. `npx eslint` could not run (no `eslint.config.*` in the repo).
  The DB retry and scheduler pause were not exercised live; the server was not
  started.
- Limitations/follow-up: A deployment that sets `AI_USER_DAILY_LIMIT=5`
  explicitly keeps 5. The storefront may show a hard-coded "5" in its copy.
  The local DNS issue itself is environmental (VPN/corporate DNS on the
  Ethernet adapter). Workarounds are a non-SRV `mongodb://` connection string
  or fixing the adapter's DNS order.

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
