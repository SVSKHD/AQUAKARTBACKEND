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

## 2026-11-11

### CRM GSTIN lookup via Masters India (GST portal record)

- Request/problem: The CRM invoice form should fetch GST details from the
  government GST portal when a GSTIN is typed. The portal has no open API (its
  public search needs a captcha); machine access goes through a licensed GSP.
  The user chose Masters India.
- Changes/result: New staff-only `GET /v1/crm/admin/gstin/:gstin`
  (`userAuth.checkAdmin`, read-only). It validates format + check digit (400
  `GSTIN_INVALID`), logs in to Masters India
  (`POST https://commonapi.mastersindia.co/oauth/access_token`, token cached
  until a minute before `expires_in`, one refresh on 401/403), calls
  `GET /commonapis/searchgstin?gstin=` and returns `{ success, data }` with
  `legalName`, `tradeName`, `status`, `constitution`, `taxpayerType`,
  `registeredOn`, `cancelledOn`, one-line principal `address`, `state`,
  `pincode`, `source`, `fetchedAt`, `cached`. Errors: 404 `GSTIN_NOT_FOUND`,
  502 `GSTIN_PROVIDER_AUTH`/`GSTIN_PROVIDER_ERROR`/`GSTIN_PROVIDER_UNREACHABLE`,
  503 `GSTIN_LOOKUP_DISABLED` (credentials not set; no provider call), 504
  `GSTIN_PROVIDER_TIMEOUT`. Results cached in memory 24 h (not-found 1 h, max 500) because lookups are billed. Credentials are read from env only and never
  logged or returned.
- Files: `src/services/gstinLookup.js` (new), `src/controllers/crm/gstinLookup.js`
  (new), `src/routes/crm/invoice.js`, `src/docs/gstinLookup.js` (new),
  `swagger-autogen.js`, `swagger-output.json`, `.env.example`
  (`MASTERS_INDIA_USERNAME`, `MASTERS_INDIA_PASSWORD`, `MASTERS_INDIA_CLIENT_ID`,
  `MASTERS_INDIA_CLIENT_SECRET`, optional `MASTERS_INDIA_BASE_URL`,
  `GSTIN_LOOKUP_TIMEOUT_MS`), `test/gstinLookup.test.js` (new),
  `docs/PROJECT_MAP.md`.
- Validation: `node --check` on changed JS files passed;
  `node --test test/gstinLookup.test.js` 11/11 passed (fake provider; no real
  Masters India calls); full `node --test` 284/285 — the one failure,
  `test/invoiceViews.test.js` "builds separate admin and customer invoice
  destinations from one id", also fails without the new test file and passes
  when run alone (pre-existing, unrelated); `npm run swagger` succeeded and the
  operation shows summary, tag `CRM / Invoices` and 200/400/401/403/404/500/
  502/503/504; `test/routeGroups.test.js` passed. `swagger-output.json` was
  re-formatted with Prettier to match the committed style (diff is additions
  for this route only).
- Limitations/follow-up: Not verified live: needs a Masters India account and
  the four env vars on the server, then a deploy. The provider's error-body
  shape is undocumented, so "not found" is detected from HTTP 404 or the
  message text. The in-memory cache is per process and resets on restart.

## 2026-11-10

### Agent tooling: project-memory map, CLAUDE.md and Stop hook

- Request/problem: Set up the `project-memory` workflow (component map, plan scope,
  Stop hook) without creating a second change log next to this one.
- Changes/result: Added `CLAUDE.md`, which imports `AGENTS.md` and points to this
  log and `docs/PROJECT_MAP.md`. Added `.claude/map.md`, a generated component map
  with component purposes and 7 problem-routing rows; file-level descriptions are
  still `TODO`. Added `.claude/hooks/` (`build_map.py`, `review_changes.py`,
  `check_memory.py`). `check_memory.py` was changed so its change-log check reads
  `docs/CHANGELOG.md` instead of `.claude/changes.md`. Registered a Stop hook in
  `.claude/settings.json`. No application code changed.
- Files: `CLAUDE.md`, `.claude/map.md`, `.claude/settings.json`,
  `.claude/hooks/build_map.py`, `.claude/hooks/review_changes.py`,
  `.claude/hooks/check_memory.py`, `docs/CHANGELOG.md`.
- Validation: `python .claude/hooks/build_map.py .` regenerated the map
  (30 components, 305 files). The Stop hook was dry-run locally with an empty payload.
  The application test suite was not run because only tooling and docs changed.
- Limitations/follow-up: Re-running the skill's `init_memory.py` overwrites
  `.claude/hooks/check_memory.py` and undoes the `docs/CHANGELOG.md` change. 305
  file descriptions in `.claude/map.md` are still `TODO` and get filled in as files
  are touched. The hook needs `python` on PATH.

### Catalog CRUD: JSON errors for large uploads, image checks, safe Cloudinary cleanup

- Request/problem: Phase 1 of the CRUD fix plan (`.claude/plan.md`):
  category update failed on large images, and Cloudinary images leaked or
  could be deleted while still in use. The live CRM error was not replayed
  against production. These causes were found in the code:
  - **No JSON error handler.** A multipart file over the multer limit
    returned an HTML 500, and a body over 50 MB or malformed JSON returned an
    Express HTML 413/400. The CRM expects `{ success, message }`.
  - **No image checks.** Base64 images of any size or content went straight
    to Cloudinary. Failures came back as a 500 that included Cloudinary's
    raw error message.
  - **Unsafe deletes.** The category update deleted removed photos even when
    another record used them.
  - **Product media deletes failed silently.** `deleteMedia` called
    `destroy` with `resource_type: "auto"`. The Cloudinary SDK puts this
    straight into the URL (`/auto/destroy`), and per Cloudinary's API
    destroy takes image, video or raw. The failure was caught and only
    logged.
  - **Product delete order.** Product delete removed media before the
    database delete.
  - **Orphaned uploads.** Product create/update and subcategory create/update
    didn't remove new uploads when the write failed. Subcategory and
    category deletes and subcategory photo replacement left images in
    Cloudinary.
  - **Internal errors exposed.** Category/subcategory 500s returned
    `error.message`.
  - **Duplicate titles.** Duplicate category/subcategory titles were allowed
    through the CRM routes, though the MCP tools already refused them.
- Changes/result:
  - **New `src/middleware/jsonErrors.js`, mounted last in `app.js`.** It
    returns a JSON 413 for oversized bodies and multer size limits, a JSON
    400 for malformed JSON, and otherwise a 4xx/500 with a generic message
    and no stack trace.
  - **Image checks in `src/utils/catalogPhotos.js`.**
    - `assertImageDataUri` and `assertImageBuffer` check that the content
      really is a JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF, by magic
      bytes. A mislabelled real image is still accepted. SVG is refused.
    - Size limit is `CATALOG_MAX_IMAGE_BYTES` (default 10 MB). Over the limit
      returns 413, a non-image returns 400.
    - Every image is checked before any is uploaded.
  - **Cleanup helpers in `src/utils/catalogPhotos.js`.**
    - `scheduleMediaCleanup` runs after the response. It skips any public id
      or URL still used by a category, subcategory, product (photos/arPhotos)
      or blog (titleImages/photos).
    - It takes the resource type from the URL, skips external URLs and
      made-up ids, retries once, and then logs the failure.
    - `scheduleUploadCleanup` removes a failed request's new uploads.
    - `resolveCatalogPhotos` now records its uploads.
  - **Category and subcategory.**
    - Duplicate titles return 409 (case-insensitive, trimmed; subcategories
      global, matching MCP and `/subcategory-title/:title`). Only a changed
      title is checked.
    - New uploads are removed if the write fails.
    - Replaced and deleted photos are cleaned up when nothing else uses them.
      Subcategory replacements used to stay in Cloudinary.
    - Subcategory update accepts `clearPhotos: true`; combined with a
      non-empty `photos` it returns 400. An omitted list or `photos: []`
      still keeps the current photos (CRM contract unchanged).
    - Create/update/delete 500s return a generic message.
    - The category update returns 404 if the record disappears during the
      update.
  - **Product.**
    - Photo data URIs and files are checked. AR files are not.
    - New uploads are removed when validation, the taxonomy check or the
      write fails.
    - A product deleted during an update returns 404 instead of a 500.
    - Media is deleted only after the database delete or update, with the
      correct resource type and the reference check.
    - The broken `deleteMedia` was removed.
  - **Swagger.** It documents 409/413, `clearPhotos`, the image rules and the
    cleanup behaviour.
- Files: `app.js`, `src/middleware/jsonErrors.js` (new),
  `src/utils/catalogPhotos.js`, `src/controllers/category.js`,
  `src/controllers/sub-category.js`, `src/controllers/product.js`,
  `src/docs/categories.js`, `swagger-output.json` (regenerated; it also picks
  up the uncommitted storefront docs already in the working tree),
  `test/catalogMedia.test.js` (new), `test/catalogCrmContract.test.js` and
  `test/subcategoryRoutes.test.js` (mock `exists()`, await cleanup),
  `docs/PROJECT_MAP.md`, `docs/CHANGELOG.md`, `.claude/map.md`,
  `.claude/plan.md`.
- Validation:
  - `node --check` passed on every changed JS file.
  - Focused tests:
    `node --test test/catalogMedia.test.js test/catalogCrmContract.test.js
test/subcategoryRoutes.test.js test/productReferences.test.js
test/mcpCatalogTools.test.js test/mcpTaxonomySeo.test.js` passed
    45/45. These are unit/route tests with models and Cloudinary mocked,
    including a real 10 MB+ multipart upload against the category route.
  - Full `node --test`: 262/263 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` test ("builds separate admin and customer
    invoice destinations from one id").
  - `npm run swagger` succeeded. The category/subcategory add/update
    operations list 409 and 413 under Categories/Subcategories.
  - ESLint:
    - Fixed the `no-use-before-define` and `import/no-named-as-default`
      errors it reported on the new code.
    - The remaining errors are rules that already fail repo-wide (quotes,
      curly, operator-linebreak) and the 4 `no-unused-vars` that were
      already in `app.js`.
  - Not run:
    - The new tests were not run against the old code, because the new
      helpers they import don't exist there.
    - No live, production or Cloudinary requests were made.
    - Not deployed.
- Limitations/follow-up:
  - **Possible new rejections.**
    - Images over 10 MB, and non-images, are now refused before upload.
    - The duplicate-title 409 could block a CRM create if production already
      holds a duplicate title.
    - The 413/400 bodies are now JSON instead of HTML.
  - **Route not changed.** `src/routes/product.js` still answers multer size
    errors with its own 400 (it was not in scope).
  - **Cleanup limits.**
    - Cleanup has one retry and no persistent queue.
    - Each removed image costs up to 4 `exists` queries, run after the
      response.
  - **Not covered.**
    - The MCP tools keep their own media logic.
    - Remote image URLs are still fetched by Cloudinary, not by this server.
  - **Undocumented env var.** `CATALOG_MAX_IMAGE_BYTES` is not yet listed in
    `.env.example`.
  - **Later phases.** Phases 2–5 (security, orders/payments, dead code,
    performance) are listed in `.claude/plan.md` and are not started.

### Agent tooling: removed the project-memory setup

- Request/problem: The user asked to remove the project-memory skill setup
  from this repo.
- Changes/result:
  - Deleted `CLAUDE.md`, `.claude/map.md`, `.claude/plan.md`,
    `.claude/hooks/` and `.claude/settings.json`. That file only registered
    the Stop hook, so the Stop hook is gone too.
  - Kept `.claude/settings.local.json`, which existed before the setup.
  - None of the deleted files were committed.
  - `AGENTS.md`, `docs/PROJECT_MAP.md` and this log stay the source of
    truth. The two entries above that mention `.claude/plan.md` and
    `.claude/map.md` now refer to deleted files.
- Open follow-ups from the deleted plan (not started):
  - **Phase 2, security.** Each needs proof that no consumer still calls
    it before it is removed or locked down:
    - `POST /v1` echoes and logs any body (`app.js`)
    - `POST /v1/notify/send-whatsappp` sends WhatsApp messages without
      auth (`app.js`)
    - `GET /v1/product-delete/:id` and `GET /v1/notify/send-whatsapp/:no`
      do writes through GET
    - `POST /v1/order/cod`, `POST /v1/order/pay`,
      `POST /v1/phonepe-verify/:id` and `GET /v1/order/:id` have no auth
      (`src/routes/orders.js`)
    - the 50 MB JSON body limit
    - rate limits are applied unevenly
  - **Phase 3, orders/payments.** Orders can be edited through three
    routes, and the legacy PhonePe flow sits next to `/v1/checkout`.
  - **Phase 4, dead code.**
    - `src/routes/crm/category.js` is imported but not mounted, and broken
    - `src/routes/crm/product.js` and `src/routes/crm/subCategory.js` are
      empty
    - `GET /blog/:title` can't be reached
    - `router.get("invoice-status")` has no leading slash
    - `app.js` has unused `AdminCategoryRoutes`, `upload`, `BASE` and `KEY`
    - `escapeRegex` is duplicated 8 times
  - **Phase 5, performance.** Use `.lean()` and pagination for unbounded
    lists (`/allcategories`, `/all-products`, `relatedProducts`).
  - **Also open.** The `checkAdmin` and `requirePermission` auth models are
    mixed, and title uniqueness is only enforced in the application (no
    unique index).
- Files: `CLAUDE.md`, `.claude/map.md`, `.claude/plan.md`,
  `.claude/hooks/`, `.claude/settings.json` (all deleted),
  `docs/CHANGELOG.md`.
- Validation: `ls .claude` shows only `settings.local.json`; `git status`
  shows no `CLAUDE.md` or `.claude/` changes. No code changed and no tests
  were needed.
- Limitations/follow-up: The skill itself is still installed in the user's
  Claude account (synced skills); only this repo's setup was removed.

### Category image upload: classified errors (400/413/502/500) and multipart keepPhotos

- Request/problem:
  - **Report.** `PUT /v1/category-update/:id` failed in the CRM for a valid
    1254x1254 PNG of about 2 MiB, sent as a base64 data URI.
  - **Local reproduction.** Real `express.json` (50mb), the real category
    route, image checks and error handler; models and Cloudinary mocked.
    - Generated PNGs at 1254x1254, with and without tEXt/pHYs/iTXt
      metadata. The fixtures were 3.8 MiB, which is larger than reported.
    - Both passed `assertImageDataUri` and were uploaded once, with the data
      URI intact. Both were saved after the kept existing photo and
      returned 200 in about 150 ms.
    - **The backend code path does not fail for this image.**
  - **Confirmed defect.** A Cloudinary rejection or timeout reached the CRM
    as a generic `500 "Something went wrong"`. The SDK rejects with a plain
    `{ message, http_code }` object, not an Error, so it fell through to the
    generic 500. The Cloudinary reason was only in the server log, which
    made the production failure undiagnosable from the CRM.
  - **Root cause in production: not confirmed.** It is one of two:
    - Cloudinary rejected the upload or timed out (a JSON 500 before this
      change).
    - A proxy or hosting body-size limit in front of `api.aquakart.co.in`
      blocked the roughly 2.8 MB JSON body before Express (HTML 413 or a
      network/CORS error). No proxy config is in this repo.
  - **Also found.** Multipart updates replaced the whole photo list, so
    multipart could not add a photo while keeping the others.
- Changes/result:
  - **Classified upload errors (`src/utils/catalogPhotos.js`).**
    - `uploadToCloudinary` and `cloudinaryUploadError` classify upload
      failures. Cloudinary 400 "too large" → **413**
      `IMAGE_TOO_LARGE_FOR_CLOUDINARY`. Cloudinary invalid image → **400**
      `IMAGE_REJECTED_BY_CLOUDINARY`. Timeouts → **502**
      `CLOUDINARY_TIMEOUT`. Anything else → **502**
      `CLOUDINARY_UPLOAD_FAILED`.
    - 502 responses don't include Cloudinary's raw text (signature
      messages stay in the log).
    - A structured, token-free log line records folder, `photoIndex`,
      `http_code` and the message.
  - **One error response shape.** `sendCatalogError` returns
    `{ success: false, message, code, stage, photoIndex? }`.
    - Stages are request, validation, cloudinary_upload, database and
      server.
    - Mongo/Mongoose failures → 500 `DATABASE_ERROR`; ValidationError → 400
      `VALIDATION_FAILED`.
    - Category and subcategory create/update/delete use it.
    - `photoInputError` and `photoTooLargeError` carry `INVALID_PHOTO` and
      `IMAGE_TOO_LARGE`. `src/middleware/jsonErrors.js` adds
      `REQUEST_TOO_LARGE`, `FILE_TOO_LARGE`, `INVALID_JSON`,
      `INVALID_UPLOAD` and `SERVER_ERROR`.
  - **Multipart category update: optional `keepPhotos`.** A JSON array of
    existing `{ id, secure_url }` objects, kept in order, with the uploaded
    files added after them. This lets the CRM upload multipart files
    instead of base64 JSON. Without `keepPhotos` the old replace behaviour
    is unchanged.
  - **Upload limits.** Multipart uploads are limited to 10 files
    (`upload.array("photos", 10)`). A failing file's `photoIndex` counts
    after the kept photos.
  - **Existing references are preserved.** On any failure nothing is
    written, existing photos are untouched, and only this request's new
    uploads are removed.
  - **Swagger.** `CategoryError` documents `code`, `stage` and
    `photoIndex`; add/update list 502; update lists `keepPhotos`.
- Files: `src/utils/catalogPhotos.js`, `src/controllers/category.js`,
  `src/controllers/sub-category.js`, `src/routes/category.js`,
  `src/middleware/jsonErrors.js`, `src/docs/categories.js`,
  `swagger-output.json`, `test/categoryImageUpload.test.js` (new),
  `test/catalogMedia.test.js` (expects `code`/`stage` on the 400 body),
  `docs/PROJECT_MAP.md`, `docs/CHANGELOG.md`.
- Validation:
  - Reproduction script (scratchpad, not committed), run before the fix:
    PNG with and without metadata → 200. Simulated Cloudinary size
    rejection and timeout → generic 500.
  - `node --test test/categoryImageUpload.test.js`: 11/11 passed. Coverage:
    - a 1.5–2.6 MiB 1254x1254 PNG, with and without metadata, as a JSON
      data URI
    - JPEG and WebP data URIs
    - multipart PNG, JPEG and WebP with `keepPhotos`
    - four Cloudinary rejection shapes, plus a multipart upload failure
    - a database failure, and validation failures with codes
  - Catalog/MCP focused suites pass.
  - Full `node --test`: 273/274. The failure is the pre-existing
    `test/invoiceViews.test.js`.
  - `npm run swagger` succeeded.
  - Not run: no request to production, Cloudinary or MongoDB.
- Limitations/follow-up:
  - **Find the production cause.** Get the CRM's status code and
    content-type for the failing request, or the server log line
    `Error updating category:` / `Cloudinary upload failed`. An HTML 413 or
    a CORS error points to a proxy limit; a JSON response now names the
    stage.
  - **CRM change needed.** The CRM (separate repo) must send multipart with
    `keepPhotos` to stop embedding base64.
  - **Product uploads are unchanged.** They already returned 502 with
    Cloudinary's message.
  - **Paused work.** The order security work for the 2026-11-10 scan is
    paused and uncommitted: route auth, ownership checks and
    `updateOwnOrder` are in `src/routes/orders.js`,
    `src/controllers/order.js` and `src/middleware/user.js`. The legacy
    PhonePe pay/verify changes and its tests are not done yet.
  - **Leaked key.** `src/utils/sendWhatsApp.js` contains a hardcoded
    fallback WhatsApp API key. It needs rotation and removal (not changed
    here).

## 2026-11-09

### Storefront AI: filters by water problem, products up front, one-reply questionnaire

- Request/problem: questions like "I see a lot of mud in the water" or about
  iron filters should get the right filter, with products shown cleanly and up
  front. Missing details should be gathered in one questionnaire the customer
  answers in a single reply.
- Changes/result:
  - Filters (category or title with "filter"/"sandfilter", softeners excluded)
    are grouped by problem. Titles with sand/sediment/silt/mud go to the mud,
    sand, silt or cloudy water group; titles with iron go to the iron (orange or
    brown stains, metallic taste or smell) group. Catalogue lines show
    automatic or manual backwash when the title or description says so, plus
    the problem. A "Filters by the water problem they solve" list is added to
    the prompt. Live lineup (read-only MCP listing): mud group: Kent
    Sandfilter, kent Automatic Sandfilter 100L; iron group: Kent Iron Filter.
  - Filter rule: sand filter first, then the iron filter, if the water has
    both. The filter goes before a softener on hard water. Filters are
    installed at the borewell outlet or before the overhead tank. The
    assistant suggests a water test and a site visit.
  - Answer layout: one line naming the problem, then the recommended products
    one line each (bold exact name, what it does, automatic or manual, what it
    suits), then at most three short bullets, then the questionnaire.
  - Questionnaire: every missing detail is asked at once in one numbered block
    with inline options (water source, home and bathrooms, what you see,
    install spot), with a one-message reply example. This replaces the earlier
    one-question-at-a-time rule for unclear softener home types. When the
    problem is already clear, the best-fitting products are still shown first.
- Files: `src/services/aiCatalogue.js`, `test/aiCatalogue.test.js`,
  `docs/CHANGELOG.md`.
- Validation: `node --check src/services/aiCatalogue.js` passed;
  `node --test test/aiCatalogue.test.js` 6/6 passed;
  `node --test test/gemini.test.js test/aiQuota.test.js` 13/13 passed. No live
  chat was run.
- Limitations/follow-up: the layout and questionnaire are prompt rules, not a
  structured response, so the storefront renders them as normal text. Guest
  replies are capped at 600 output tokens, so long answers may be cut. The
  "Softener-&-Sand-Filter-Combos" category has no products, so combos are
  described as a sand filter plus a softener rather than shown as one product.

### Storefront AI: frontend contract for product cards and the questionnaire

- Request/problem: write down what the storefront must do with the AI answer
  (the frontend handshake).
- Changes/result:
  - New guide `docs/STOREFRONT_AI_CHAT.md` covers the chat endpoints, request
    body and limits, and the SSE events. Bold-name product cards: match
    normalised titles against `GET /v1/all-products?query=ecom` (strip
    `| Aquakart`), keep reply order, convert a string `discountPrice` with
    `Number()`. Non-product items (NRV, on-demand pumps) get no card. The guide
    also gives the questionnaire block format and parsing rules (chips, one
    composed reply), errors and quota, expected cards per question, and an
    acceptance checklist.
  - The questionnaire prompt rule now fixes a parseable format: a
    `Quick questions:` line, then one `N. Label: option / option` line per
    question, ending with `Reply in one message, e.g. ...`. Previously the
    example put every question on one line.
  - `docs/README.md` links the new guide.
- Files: `docs/STOREFRONT_AI_CHAT.md` (new), `docs/README.md`,
  `src/services/aiCatalogue.js`, `test/aiCatalogue.test.js`,
  `docs/CHANGELOG.md`.
- Validation: `node --check src/services/aiCatalogue.js` passed;
  `node --test test/aiCatalogue.test.js` 6/6 passed (now checks the
  questionnaire header and line format). The contract was checked against
  source (`src/routes/ai.js`, `src/controllers/ai.js`,
  `src/controllers/product.js`). No storefront code was changed or tested, and
  no live chat was run.
- Limitations/follow-up: the bold names and questionnaire are text conventions
  the model is told to follow, not a structured response field, so the
  frontend needs the plain-markdown fallback. Structured `products` and
  `questionnaire` fields in `done` / `data` would make this reliable.

### Storefront AI: recommend softeners by home type, not the whole category

- Request/problem: for a question like "I live in a villa", the storefront
  assistant named every softener (8L, Bathroom 5.5L, washing-machine unit and
  more) instead of the Auto 25 and Auto 40. The app shows a card for every
  bold product name, and the prompt even told the model to mention
  one-bathroom units when ruling them out. Softeners without "Resin Volume" in
  the description (for example Auto 25, 100L) got no size or home type.
- Changes/result:
  - Softener size now comes from the description's resin volume, or from the
    title when that is missing ("Automatic 8L", "Water Softener 40", "Auto 25").
  - Every softener is put in exactly one group: washing machine only; one
    bathroom (flat or apartment, washing/bathroom titles or ≤12 L); whole home
    (villa, duplex or independent house, 13–60 L); large building (apartment
    block, hostel, hotel or commercial, >60 L). Catalogue lines show
    `for <group>`, and a "Softeners by the home they suit" list is added to the
    prompt. On the live lineup the villa group is the 25 and the 40.
  - Prompt rules: bold only recommended products, never the ones being ruled
    out; name one or two fitting products and none from other groups; villas
    and homes with 2+ bathrooms get only the whole-home group; ask one short
    question when the home type is unclear.
  - Catalogue prices now treat a string `discountPrice` as a number, because
    one live softener stores it that way.
  - This entry also covers the earlier uncommitted villa wording in the same
    file, which this change replaces.
- Files: `src/services/aiCatalogue.js`, `test/aiCatalogue.test.js`,
  `docs/CHANGELOG.md`.
- Validation: `node --check src/services/aiCatalogue.js` passed;
  `node --test test/aiCatalogue.test.js` 4/4 passed;
  `node --test test/gemini.test.js test/aiQuota.test.js` 13/13 passed. ESLint
  reports quote/linebreak errors that the committed file already has (the repo
  uses Prettier formatting), so lint was not a gate. Product titles came from a
  read-only MCP listing of the live Softeners category. No live chat was run,
  so the model's answers have not been checked against the new prompt.
- Limitations/follow-up: the grouping is a prompt guide, so the model can
  still stray. The storefront decides which bold names become cards, and its
  matching was not reviewed (separate repo). The catalogue is cached for
  10 minutes after deploy. `aquakart_list_products` (MCP) fails when a product
  has a string `discountPrice`: its output schema expects a number. "Kent
  Automatic Water Softener 40" is filed under the subcategory
  "Wall-Mount-Ro-Purifiers". Neither was changed here.

### Storefront AI: softener installation spot (terrace or ground floor)

- Request/problem: for "where can we fix it, terrace or ground floor?", the
  assistant should give what each spot needs for regeneration.
- Changes/result: a new rule for automatic (whole-home and large-building)
  softeners in the catalogue prompt. Either spot is possible. Terrace: the
  overhead-tank pressure is too low for regeneration, so a pressure booster
  pump is needed, and the assistant recommends a listed pressure booster (live:
  "Grundfos 0.7hp Pressure Booster With 24Ltr Air tank", in Pressure Pumps).
  Ground level: fit a non-return valve (NRV) so water doesn't
  flow back and regeneration isn't interrupted. The assistant also suggests an
  AquaKart site visit. One-bathroom softeners fit at that bathroom's inlet.
- Files: `src/services/aiCatalogue.js`, `test/aiCatalogue.test.js`,
  `docs/CHANGELOG.md`.
- Validation: `node --check src/services/aiCatalogue.js` passed;
  `node --test test/aiCatalogue.test.js` 4/4 passed (now also checks both
  installation requirements are in the prompt). No live chat was run.
- Limitations/follow-up: the rule only adds wording to the prompt. A read-only
  MCP search of the live catalogue found no NRV product ("nrv", "valve"), so the
  NRV is described but gets no product card. Whether the 0.7hp booster suits
  every terrace install was not checked.

### Storefront AI: show all pressure boosters and on-demand 0.7–0.9 hp pumps

- Request/problem: when a booster is needed, show the pressure boosters and
  offer customised 0.7 to 0.9 hp pumps that are ordered on demand.
- Changes/result: the prompt gets a "Pressure boosters (listed): ..." line
  built from products in the Pressure Pumps category or with booster in the
  title. The category match is needed because one live title is spelled "Kent
  Pressure Bootser". A new rule: whenever a booster or pump comes up (terrace
  softener install, low pressure, or a direct question), bold every listed
  booster so each shows as a card. The assistant adds that customised 0.7 to
  0.9 hp pumps can be ordered on demand, with size and price confirmed by
  AquaKart after a site visit. The terrace rule now points to this one instead
  of recommending a single booster. Live boosters (read-only MCP listing):
  Kent Pressure Bootser, Grundfos 0.7hp Pressure Booster With 24Ltr Air tank.
- Files: `src/services/aiCatalogue.js`, `test/aiCatalogue.test.js`,
  `docs/CHANGELOG.md`.
- Validation: `node --check src/services/aiCatalogue.js` passed;
  `node --test test/aiCatalogue.test.js` 5/5 passed. No live chat was run.
- Limitations/follow-up: on-demand pumps are not catalogue products, so they
  get no card or price in the app. The "Bootser" typo in the live product title
  was not corrected.

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

### MCP sign-in: tolerant client registration, OAuth failure logs, manual client fallback

- Problem: a connector (the `ofid_…` reference format suggests ChatGPT)
  reported "Couldn't register with Aquakart's sign-in service".
  - **Live checks:** read-only probes of `api.aquakart.co.in` showed the
    metadata returns 200 and lists all scopes, and `/register` answers. It
    rejected a fake callback with a clear `invalid_client_metadata`, and the
    rate limit (19/20 left) was not the cause.
  - **Likely causes:** a registration was refused whenever the client
    offered _any_ redirect URI not on the allowlist, and the `*` callback
    match allowed only a single path segment.
  - **Diagnosis gap:** rejected registrations left no log, so the exact
    cause could not be seen.
- Changes/result:
  - **Redirect URIs:** registration keeps the allowlisted redirect URIs,
    drops unlisted extras, and fails only when none is allowed.
  - **Wildcard match:** `*` allowlist entries now match one or more
    URL-safe path segments (never a query string or `..`).
  - **Logging:** `mcp.oauth.register` is logged for every registration and
    `mcp.oauth.failed` for every failed `/register`, `/authorize`, `/token`
    or `/revoke`. No codes, tokens, secrets or PKCE verifiers are logged.
  - **Manual fallback:** `npm run mcp:grants -- add-client <name>
<redirectUri…>` pre-registers a public client for the connector's
    "OAuth Client ID" field, and `npm run mcp:grants -- clients` lists the
    registered clients.
- Files: `src/services/mcp/oauthProvider.js`, `src/services/mcp/config.js`,
  `src/routes/mcp.js`, `src/scripts/mcp-grants.js`,
  `test/mcpOAuthRegister.test.js` (new), `docs/MCP_BLOG_PUBLISHING.md`,
  `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed on every changed file.
  - The MCP suites plus the new `test/mcpOAuthRegister.test.js`: 55/55
    passed.
  - The live probes above were read-only, or rejected before anything was
    saved.
  - I did not register a real client or check ChatGPT end to end.
- Limitations/follow-up:
  - Not deployed.
  - **Unconfirmed cause:** the root cause is not confirmed. After you
    deploy, retry, then read the `mcp.oauth` log lines to see the exact
    redirect URI and auth method the client sent.

### Docs: MCP walkthrough with the Aquakart logos

- Request: a Markdown walkthrough of the MCP server, with the white and
  original logos.
- Changes/result: new step-by-step guide `docs/MCP_WALKTHROUGH.md`. It
  covers:
  - both logos (badge images, plus the clean files to use as references)
  - permissions
  - connecting Claude, Claude Code and ChatGPT
  - the consent page and its scopes
  - example requests for blogs, products, coupons, categories, SEO and
    Instagram
  - safety rules, troubleshooting, admin commands and what is still
    unverified

  It is linked from `docs/README.md`. The technical reference stays in
  `docs/MCP_BLOG_PUBLISHING.md`.

- Files: `docs/MCP_WALKTHROUGH.md` (new), `docs/README.md`,
  `docs/CHANGELOG.md`.
- Validation: docs only. I checked the content against the current source
  (`src/services/mcp/config.js`, `consentPage.js`, `server.js`,
  `taxonomySeoSchemas.js`, `src/scripts/mcp-grants.js`); I did not run any
  code.
- Limitations/follow-up: the guide describes the code in this repo. The
  registration fix and failure logs work only once deployed.

### Fix CRM subcategory edit: add `PUT /v1/subcategory-update/:id`

- Problem: editing a subcategory in the CRM did nothing.
  - **Cause:** the CRM sends `PUT /v1/subcategory-update/<id>`, but the
    backend only had `POST /v1/subcategory-update` with the id in the body.
  - **Live check:** a request with no token, so nothing could be written,
    returned 404 for the PUT route and 401 for the POST route.
- Changes/result:
  - Added `PUT /v1/subcategory-update/:id` (admin-only, same controller).
    The controller already reads the id from the path first, then from
    `id`/`_id` in the body.
  - The legacy POST route still works.
  - Swagger documents the new operation, and the POST description points
    to it.
- Files: `src/routes/sub-category.js`, `src/docs/categories.js`,
  `swagger-output.json`, `test/subcategoryRoutes.test.js` (new),
  `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed on the changed files.
  - `node --test test/subcategoryRoutes.test.js`: 3/3 passed with mocked
    models. They cover the CRM payload, the legacy POST, 401 without a
    token, 400 for a bad id and 404 for a missing subcategory.
  - `npm run swagger` succeeded; `/v1/subcategory-update/{id}` (put) is
    added under Subcategories with admin auth.
  - Full `node --test`: 233/234 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` test.
  - I did not replay the CRM request against production.
- Limitations/follow-up:
  - Not deployed.
  - Photos sent as `{ id, secure_url }` objects (rather than data URIs
    or URLs) are still passed to Cloudinary upload by the existing
    controller. The CRM sent `photos: []` here, which keeps the existing
    photos.

### Fix subcategory photos: keep existing photos instead of re-uploading

- Problem: the subcategory create and update controller passed every
  `photos` entry to `cloudinary.uploader.upload`. Existing photos sent
  back by the CRM as `{ id, secure_url }` objects made the request fail
  with a 500. URLs already in Cloudinary were uploaded again as
  duplicates.
- Changes/result: new `resolveSubCategoryPhotos` in
  `src/controllers/sub-category.js`, used by create and update.
  - `{ id, secure_url }` entries are kept as they are.
  - `https://res.cloudinary.com/<own cloud>/…` URLs are kept, with the
    public id derived by `publicIdFromUrl` (transformations and version
    ignored).
  - Data URIs and other http(s) URLs are uploaded to `subcategories/` as
    before.
  - At most 10 photos. A non-array or unrecognised entry returns 400
    instead of 500.
  - On update, an omitted or empty `photos` still keeps the current
    photos. Replaced photos are still not deleted from Cloudinary (no
    change).
  - Swagger now describes the accepted photo forms.
- Files: `src/controllers/sub-category.js`, `src/docs/categories.js`,
  `swagger-output.json`, `test/subcategoryRoutes.test.js`,
  `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed.
  - `node --test test/subcategoryRoutes.test.js`: 6/6 passed with
    Cloudinary and models mocked. Coverage: mixed existing, own-URL and
    data-URI photos (one upload only), public-id parsing, and 400s for
    invalid entries.
  - Full `node --test`: 236/237 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` test.
  - `npm run swagger` succeeded.
  - No production calls.
- Limitations/follow-up: not deployed. Category photo updates use
  multipart uploads and were not changed.

### CRM ↔ backend catalog CRUD audit: category photos, delete paths, product photo deletion

- Request: check the CRM ↔ backend connection for full CRUD on products,
  categories and subcategories.
- Method:
  - Read the CRM calls in `AQUACRM25DEV/src/services/apiService.ts`,
    `src/services/api.ts` (always JSON) and `ProductsTab.tsx` /
    `PhotoUploader.tsx` (photos are `{ id, secure_url }`; new picks carry a
    random id and a data: URI).
  - Compared them with the routes and controllers here.
  - The CRM repo was read only and not changed.
- Findings and fixes:
  - **Category create always failed from the CRM:** "No photos provided",
    because the backend read only multipart files and the CRM sends JSON.
    Create now also accepts a JSON `photos` array; multipart still
    works.
  - **Category update ignored JSON photos:** text saved, photo changes were
    lost. A JSON `photos` list now replaces the list. Existing entries are
    kept, new ones are uploaded to `categories/`, and only photos no longer
    in the list are deleted, after the save. Multipart behaviour is
    unchanged. `checkAdmin` now runs before multer on this route.
  - **Category and subcategory delete returned 404:** the CRM calls
    `DELETE category-delete/:id` and `subcategory-delete/:id`. Added both
    paths, with the same controller and the same in-use checks; the old
    paths stay.
  - **Product update deleted the photos it kept:** with a non-empty
    `photos` list it deleted _all_ previous Cloudinary photos, including
    the ones the CRM sent back to keep. It now deletes only removed photos
    (photos and AR photos), after the update is saved.
  - **Subcategory photos (correcting the earlier fix today):** a new CRM
    pick `{ id: <random>, secure_url: "data:…" }` was treated as an
    existing photo, which would have stored base64 in MongoDB. Shared rules
    now live in the new `src/utils/catalogPhotos.js`:
    - data URIs are always uploaded
    - URLs in our Cloudinary account are kept, with the public id read
      from the URL
    - other https entries with an id are kept
    - other URLs are uploaded
    - invalid entries return 400, with at most 10 photos
  - **Already matching:** products list/create/delete, categories list,
    subcategories list/create, and subcategory update (fixed earlier today).
- Files: `src/utils/catalogPhotos.js` (new),
  `src/controllers/category.js`, `src/controllers/sub-category.js`,
  `src/controllers/product.js`, `src/routes/category.js`,
  `src/routes/sub-category.js`, `src/docs/categories.js`,
  `swagger-output.json`, `test/catalogCrmContract.test.js` (new),
  `docs/PROJECT_MAP.md`, `docs/CHANGELOG.md`.
- Validation:
  - `node --check` passed on the changed files.
  - `node --test test/catalogCrmContract.test.js
test/subcategoryRoutes.test.js`: 12/12 passed, replaying the CRM's
    payload shapes with models and Cloudinary mocked.
  - Full `node --test`: 242/243 passed. The failure is the pre-existing
    `test/invoiceViews.test.js` test.
  - `npm run swagger` succeeded; the new delete paths and updated
    descriptions are present.
  - No production requests and no CRM UI run.
- Limitations/follow-up:
  - Not deployed.
  - **Cloudinary deletes:** `deleteMedia` in `src/controllers/product.js`
    calls `destroy` with `resource_type: "auto"`, which Cloudinary's
    destroy API may not accept. Removed product photos may therefore stay
    in Cloudinary; deletion errors are only logged. Not changed.
  - **Category photos:** category photos removed through the CRM are now
    deleted, as the multipart path already did. Subcategory photos are
    never deleted (unchanged).
  - **CRM payload:** the CRM still sends `user_id` and duplicate
    `category_id`/`category` fields; the backend ignores `user_id` for
    categories.

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
