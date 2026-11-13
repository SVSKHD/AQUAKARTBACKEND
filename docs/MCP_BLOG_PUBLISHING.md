# Aquakart MCP server: blogs, Instagram, catalogue, coupons and SEO

Last reviewed: 2026-11-06 (Asia/Calcutta). Verify details in source:
`src/routes/mcp.js`, `src/services/mcp/`, `src/models/mcp/`,
`src/validators/mcp/blog.js`. Tests: `test/mcpServer.test.js`,
`test/mcpBlogTools.test.js`, `test/mcpInstagram.test.js`,
`test/mcpCatalogTools.test.js`, `test/mcpTaxonomySeo.test.js`,
`test/blogRoutesRegression.test.js`.

A remote MCP server lets an authorized MCP client (ChatGPT, Claude, Claude
Code, MCP Inspector) do these jobs:

- read blogs
- create and edit blog drafts
- upload and attach blog images
- publish blogs
- post images to the Aquakart Instagram account
- read the product catalogue and add products
- read coupons and create coupons
- create, read, update and delete categories and subcategories
- create, read and update page SEO, and run the SEO readiness report over
  all pages

The client starts every action. The backend has no cron job for this
workflow. The only background work is the cleanup worker, which deletes
temporary Instagram images after a verified post (see "Cleanup worker").

```text
MCP client (ChatGPT / Claude / Claude Code)
   |  OAuth 2.1 + Streamable HTTP
   v
POST /v1/mcp  ->  tools  ->  existing AquaBlog model + Cloudinary
                         ->  Meta Instagram Graph API (temp images in Cloudinary)
```

## Endpoints

The server is off until `MCP_PUBLIC_BASE_URL` is set. Until then `/v1/mcp`
answers 503 `MCP_DISABLED`. With `MCP_PUBLIC_BASE_URL=https://api.aquakart.co.in`:

| Purpose                        | URL                                                                        |
| ------------------------------ | -------------------------------------------------------------------------- |
| MCP endpoint (give to clients) | `https://api.aquakart.co.in/v1/mcp` (POST only; stateless, JSON responses) |
| Protected resource metadata    | `/.well-known/oauth-protected-resource/v1/mcp`                             |
| Authorization server metadata  | `/.well-known/oauth-authorization-server` (issuer = API origin)            |
| Client registration (DCR)      | `POST /register`                                                           |
| Authorization (PKCE S256)      | `GET /authorize`, which shows the staff sign-in/consent page               |
| Consent form submit            | `POST /v1/mcp/oauth/consent`                                               |
| One-time image upload URL      | `PUT /v1/mcp/uploads/<token>` (from `aquakart_create_image_upload`)        |
| Resource metadata (root form)  | `/.well-known/oauth-protected-resource` (same document as above)           |
| Token, refresh and revocation  | `POST /token`, `POST /revoke`                                              |

The OAuth endpoints are at the **API origin root**, not under `/v1`, because
the MCP SDK serves them relative to the issuer. The reverse proxy must forward
`/.well-known/*`, `/authorize`, `/token`, `/register` and `/revoke` to this app.

## OAuth model

- **Who can authorize:** CRM staff sign in on the consent page with their CRM
  email and password. Each scope needs the staff member's CRM permission
  (`src/services/mcp/config.js` `SCOPE_PERMISSIONS`):
  - `blogs:*` and `media:upload` need `blogs.manage`
  - `instagram:*` needs `instagram.publish`, a new permission; assign it to
    the role in CRM Access Control
  - `products:read` needs `products.read` and `products:write` needs
    `products.manage`. Both are new and assigned to no role, so only
    super-admins and role 1 have them, matching the admin-only CRM product
    routes
  - `coupons:read` needs `coupons.read` and `coupons:write` needs
    `coupons.manage`, the same permissions the CRM coupon routes use
  - `categories:read` and `categories:write` need `products.read` and
    `products.manage` (the CRM category routes are admin-only)
  - `seo:read` and `seo:write` need `seo.read` and `seo.manage`

  Super-admin and legacy role 1 have every permission.

- **Scopes:** `blogs:read`, `blogs:write`, `media:upload`, `blogs:publish`,
  `instagram:read`, `instagram:upload`, `instagram:publish`,
  `instagram:cleanup`, `products:read`, `products:write`, `coupons:read`,
  `coupons:write`, `categories:read`, `categories:write`, `seo:read`,
  `seo:write`. Live-effect scopes start unticked on the consent page
  (`blogs:publish`, `instagram:publish`, `instagram:cleanup`,
  `products:write`, `coupons:write`, `categories:write`, `seo:write`), so
  granting them is always a
  deliberate choice. No scope reaches customers, orders, payments or other
  CRM data.
- **Clients:** Dynamic Client Registration only accepts redirect URIs on the
  allowlist:
  - ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect` and
    `https://chatgpt.com/connector/oauth/*`
  - Claude: `https://claude.ai/api/mcp/auth_callback` and
    `https://claude.com/api/mcp/auth_callback`
  - loopback `http://localhost:*` for Claude Code and Inspector, controlled by
    `MCP_OAUTH_ALLOW_LOOPBACK_REDIRECTS` (default true)

  Clients are registered as **public PKCE clients**, so no client secret is
  issued or stored. The SDK would otherwise keep secrets in plaintext and
  expire them after 30 days.

  - A `*` entry matches one or more URL-safe path segments, such as
    ChatGPT's `connector/oauth/{callback_id}`. A query string or `..` never
    matches.
  - If a client offers several redirect URIs, only the allowlisted ones are
    registered and the rest are dropped. Registration fails only when none
    is allowed.
  - **Troubleshooting:** every registration logs an `mcp.oauth.register`
    JSON line (client name, offered and refused redirect URIs, requested
    auth method). Every failed `/register`, `/authorize`, `/token` or
    `/revoke` logs `mcp.oauth.failed` (status, error, client id, redirect
    URI, user agent). Neither ever logs codes, tokens, secrets or PKCE
    verifiers. Use `docker logs <container> 2>&1 | grep mcp.oauth`.
  - **Manual fallback:** if automatic registration keeps failing, run
    `npm run mcp:grants -- add-client "ChatGPT" <exact redirect URI>`. Put the
    printed client id in the connector's "OAuth Client ID" field and leave
    the secret empty. `npm run mcp:grants -- clients` lists the registered
    clients. Both write to and read from the database in `.env`.

- **Tokens:** opaque random values (`aqm_at_…` lasts 1 h; `aqm_rt_…` lasts 30
  days), stored only as SHA-256 hashes and bound to the MCP resource URL.
  - Authorization codes are single-use and last 5 minutes; reusing a code
    revokes the grant.
  - Refresh tokens rotate on every use; reusing an old one revokes the
    whole grant.
  - Every request re-checks the staff account (disabled means 401) and its
    current permissions, so removing a permission takes effect immediately.
- **Revocation:** a client can call `POST /revoke`. Admins use
  `npm run mcp:grants -- list | revoke <grantId> | revoke-staff <email> | disable-client <clientId>`
  (this writes to the database configured in `.env`).

## Connecting clients

- **ChatGPT:**
  1. Go to Settings → Apps & Connectors → Advanced, turn on developer mode,
     and create a connector.
  2. Use the MCP URL above and choose OAuth authentication.
  3. ChatGPT discovers the metadata, registers itself, and opens the
     Aquakart consent page.

  Exact menu names change, so follow OpenAI's current connector docs.

- **Claude (claude.ai / desktop):** Settings → Connectors → Add custom
  connector → the MCP URL. Sign in on the consent page.
- **Claude Code:** `claude mcp add --transport http aquakart https://api.aquakart.co.in/v1/mcp`,
  then run `/mcp` to authenticate. It uses a loopback redirect.
- **Codex (desktop app or CLI):** see "Codex" below.
- **Local testing:** MCP Inspector (`npx @modelcontextprotocol/inspector`)
  against `http://localhost:5300/v1/mcp` with
  `MCP_PUBLIC_BASE_URL=http://localhost:5300`. This writes to whatever
  database `.env` points at, so use a non-production DB.

### Codex

Codex discovers everything from the 401 challenge (protected-resource
metadata → authorization-server metadata), registers itself with DCR as a
public client with a loopback redirect (`http://127.0.0.1:<port>/…`, allowed
by default via `MCP_OAUTH_ALLOW_LOOPBACK_REDIRECTS`), signs in with PKCE and
refreshes tokens. Codex tries CIMD first only when a server advertises it;
this server doesn't, so Codex uses DCR.

A plugin that bundles this server does not connect by itself. Until the
server is authenticated in Codex, no Aquakart tools appear even though the
plugin's skill loads (seen 2026-11-13: Codex logged no connection, discovery
or registration attempt at all).

1. **Desktop app:** Settings → Plugins → Aquakart → enable it, then
   **Connect / Authenticate** the Aquakart MCP server and sign in on the
   Aquakart consent page with a CRM staff account (needs `blogs.manage`;
   tick blogs:read, blogs:write, media:upload, and blogs:publish only if
   publishing should be allowed).
2. **CLI, or if the plugin route doesn't connect:** add a direct server to
   `~/.codex/config.toml` and log in:

   ```toml
   [mcp_servers.aquakart]
   url = "https://api.aquakart.co.in/v1/mcp"
   scopes = ["blogs:read", "blogs:write", "media:upload", "blogs:publish"]
   ```

   ```bash
   codex mcp login aquakart
   codex mcp list   # aquakart should show as connected
   ```

3. Start a new thread and check that `aquakart_*` tools are listed (`/mcp`).

Plugin `mcp.json` (portable layout; no secrets; DCR; discovery supplies the
endpoints):

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "aquakart": {
      "type": "streamable-http",
      "url": "https://api.aquakart.co.in/v1/mcp",
      "extensions": {
        "com.openai": {
          "auth": {
            "type": "oauth",
            "client": { "mode": "dcr" },
            "baseScopes": ["blogs:read", "blogs:write", "media:upload"],
            "defaultScopes": [
              "blogs:read",
              "blogs:write",
              "media:upload",
              "blogs:publish"
            ]
          }
        }
      }
    }
  }
}
```

Banner workflow for the plugin's content skill:

1. Generate the banner as a local PNG/JPEG/WebP (max 5 MB).
2. `aquakart_create_image_upload` → run the returned
   `curl --fail -sS -T banner.png "<uploadUrl>"` → `aquakart_get_image_upload`
   for the `mediaId`. Never pass large base64 and never invent image URLs.
3. `aquakart_create_blog` (always a draft) with title, slug, `summary`
   (excerpt), `shortDescription` (meta description), keywords/keyphrases and
   `titleImageAlt`, with a fresh `idempotencyKey` that is reused on retries.
4. `aquakart_attach_image` with the `mediaId`, `applyBrandLogo: true` and
   `altText`.
5. `aquakart_get_blog` to confirm the saved fields, then report `blogId`,
   status, banner and `adminUrl`/`publicUrl` from the results.
6. Publish only on an explicit request (`aquakart_publish_blog`).

**Branding rule for the skill:** every banner must carry the authentic
Aquakart logo, unaltered (original proportions and colours). Do not draw or
recreate the logo with image generation. Attach banners with
`applyBrandLogo: true` so the server composites the stored official logo file
(`logoVariant: "white"` on dark images); `logoApplied: true` in the result
confirms the overlay was applied. The server does not inspect an image for a
logo, so only the overlay counts as verified branding.

## Tools

All tools have strict input schemas (unknown arguments are rejected), output
schemas, `annotations` (read-only, destructive and open-world hints) and
`_meta.securitySchemes`. Every write takes an `idempotencyKey`. Reuse the
same key when retrying after a timeout.

Results:

- **Success:** `structuredContent` (and the same JSON in `content[0].text`) = `{ ok: true, …, correlationId, operationId?, replayed? }`
- **Failure:** `isError: true`; the JSON `{ ok: false, error: { code, message, details?, retryable? }, correlationId, operationId? }` is in `content[0].text` only. Error results carry no `structuredContent`: it would not match the tool's output schema, and SDK-based clients reject such results.

A missing scope returns `INSUFFICIENT_SCOPE` plus
`_meta["mcp/www_authenticate"]`, which prompts the client to re-authorize.

| Tool                               | Scope               | Input (main fields)                                                                                       | Output (main fields)                                                          |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `aquakart_get_brand_assets`        | none (any sign-in)  | none                                                                                                      | `brand` (`logos[]` original/white `url` + `previewUrl`, `overlay`, `rules`)   |
| `aquakart_list_blogs`              | `blogs:read`        | `status` draft/published/all, `query`, `page`, `limit≤50`                                                 | `blogs[]` (id, title, slug, status, revision, publicUrl)                      |
| `aquakart_get_blog`                | `blogs:read`        | `blogId` or `slug`                                                                                        | `blog` with HTML, SEO fields, references, images                              |
| `aquakart_get_blog_status`         | `blogs:read`        | `blogId` or `slug`                                                                                        | `status`, `publicUrl`, `visibleOnStorefront`, `revision`                      |
| `aquakart_create_blog`             | `blogs:write`       | `idempotencyKey`, `title` (10-120), `description` (HTML), optional slug/SEO/taxonomy fields, `modelUsed`  | `blog` (always `draft`), `warnings`                                           |
| `aquakart_update_blog`             | `blogs:write`       | `idempotencyKey`, `blogId`, `expectedRevision?`, any content field (null clears)                          | `blog`                                                                        |
| `aquakart_upload_image`            | `media:upload`      | `idempotencyKey`, `image` (ChatGPT file) **or** `imageBase64`                                             | `media` (`mediaId`, `publicId`, `secure_url`), `deduplicated`                 |
| `aquakart_attach_image`            | `blogs:write`       | `idempotencyKey`, `blogId`, `mediaId`, `applyBrandLogo?`, `logoVariant?`, `expectedRevision?`             | `blog`, `titleImage` `{ id, secure_url }`                                     |
| `aquakart_publish_blog`            | `blogs:publish`     | `idempotencyKey`, `blogId`, `expectedRevision?`                                                           | `blog`, `publicUrl`, `alreadyPublished`, `visibleOnStorefront`                |
| `aquakart_upload_instagram_image`  | `instagram:upload`  | `idempotencyKey`, `image` or `imageBase64`                                                                | `asset` (`assetId`, status, cleanup fields), `deduplicated`                   |
| `aquakart_publish_instagram`       | `instagram:publish` | `idempotencyKey`, `assetId`, `caption` (≤2,200 chars, ≤30 hashtags, ≤20 mentions, plain text), `altText?` | `asset` (`instagramMediaId`, `permalink`, `cleanupAfter`), `alreadyPublished` |
| `aquakart_get_instagram_status`    | `instagram:read`    | `assetId`                                                                                                 | `asset`                                                                       |
| `aquakart_list_instagram_posts`    | `instagram:read`    | `status?`, `page`, `limit≤50`                                                                             | `assets[]`                                                                    |
| `aquakart_cleanup_instagram_asset` | `instagram:cleanup` | `idempotencyKey`, `assetId`                                                                               | `asset`, `cleaned`, `alreadyCleaned`                                          |
| `aquakart_list_products`           | `products:read`     | `query?`, `category?`, `inStock?`, `page`, `limit≤50`                                                     | `products[]` (id, title, brand, price, offer price, stock, category, image)   |
| `aquakart_get_product`             | `products:read`     | `productId`                                                                                               | `product` with description, SEO/merchant fields, photos, rating summary       |
| `aquakart_create_product`          | `products:write`    | `idempotencyKey`, `title`, `description` (HTML), `price`, `stock`, `brand`, `mediaIds` (1-10), optional   | `product` (live immediately; `merchantEnabled` false unless asked)            |
| `aquakart_list_coupons`            | `coupons:read`      | `status?`, `query?` (code), `page`, `limit≤50`                                                            | `coupons[]` (discount, validity, limits, usage, status, `targetedAccounts`)   |
| `aquakart_get_coupon`              | `coupons:read`      | `couponId` or `code`                                                                                      | `coupon`                                                                      |
| `aquakart_create_coupon`           | `coupons:write`     | `idempotencyKey`, `code`, `discountType`, `discountValue`, `endsAt`, optional limits/restrictions/status  | `coupon` (`draft` unless `status: "active"`)                                  |

Category, subcategory and SEO tools:

| Tool                                                         | Scope              | Notes                                                                                         |
| ------------------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------- |
| `aquakart_list_categories`, `aquakart_get_category`          | `categories:read`  | Photos, keywords, subcategory/product counts; get includes subcategories                      |
| `aquakart_create_category`, `aquakart_update_category`       | `categories:write` | Create needs `mediaIds` (1-5); update is partial, takes `expectedRevision`                    |
| `aquakart_delete_category`                                   | `categories:write` | Refused while subcategories/products use it (`CATEGORY_IN_USE`)                               |
| `aquakart_list_subcategories`, `aquakart_get_subcategory`    | `categories:read`  | Optional `category` filter                                                                    |
| `aquakart_create_subcategory`, `aquakart_update_subcategory` | `categories:write` | Needs an existing parent; can't move while products use it                                    |
| `aquakart_delete_subcategory`                                | `categories:write` | Refused while products use it (`SUBCATEGORY_IN_USE`)                                          |
| `aquakart_list_seo`, `aquakart_get_seo`                      | `seo:read`         | By `seoId` or `pageKey`; `active` filter                                                      |
| `aquakart_get_seo_readiness`                                 | `seo:read`         | Every page: status, priority, score, issues, actions; `pageKey`/`entityType`/`status` filters |
| `aquakart_create_seo`, `aquakart_update_seo`                 | `seo:write`        | CRM validation; partial updates; `active: false` switches a page off                          |

Run `tools/list` for the full JSON Schemas.

Common error codes:

- **Validation and references:** `VALIDATION_FAILED`, `INVALID_REFERENCE`
- **Duplicates:** `DUPLICATE_CONTENT`, `DUPLICATE_TITLE`, `SLUG_TAKEN`,
  `DUPLICATE_SKU`, `COUPON_CODE_TAKEN`
- **Concurrency and idempotency:** `REVISION_CONFLICT`,
  `IDEMPOTENCY_KEY_REUSED`, `OPERATION_IN_PROGRESS`
- **Blogs:** `BLOG_NOT_FOUND`, `BLOG_NOT_DRAFT`, `PUBLISH_CHECKS_FAILED`
  (details list the failed checks)
- **Catalogue:** `PRODUCT_NOT_FOUND`, `COUPON_NOT_FOUND`,
  `CATEGORY_NOT_FOUND`, `SUBCATEGORY_NOT_FOUND`, `CATEGORY_IN_USE`,
  `SUBCATEGORY_IN_USE`
- **SEO:** `SEO_NOT_FOUND`, `PAGE_KEY_TAKEN`
- **Images:** `UNSUPPORTED_IMAGE_TYPE`, `IMAGE_TOO_LARGE`,
  `UNTRUSTED_IMAGE_SOURCE`, `IMAGE_DOWNLOAD_FAILED`, `MEDIA_NOT_FOUND`,
  `LOGO_NOT_CONFIGURED`
- **Instagram:** `INSTAGRAM_NOT_CONFIGURED`, `INSTAGRAM_TOKEN_INVALID`,
  `META_TIMEOUT`, `META_RATE_LIMITED`, `CONTAINER_PROCESSING`,
  `CONTAINER_FAILED`, `PUBLISH_UNCERTAIN`, `PUBLISH_UNVERIFIED`,
  `ALREADY_POSTED`, `INVALID_ASPECT_RATIO`, `INVALID_CAPTION`
- **Cleanup:** `CLEANUP_NOT_ALLOWED`, `CLEANUP_FAILED`
- **General:** `STORAGE_UNAVAILABLE`, `INTERNAL_ERROR`

## Product and coupon rules

Source: `src/services/mcp/catalogTools.js`. Data access is in
`src/services/mcp/store.js`, limited by the `PRODUCT_FIELDS` and
`COUPON_FIELDS` allowlists.

- **What reads return:** products never include `dpPrice` (dealer price),
  reviews or reviewer/customer ids. Coupons report `targetedAccounts` (a
  count) instead of the customer ids they are restricted to.
- **Products go live immediately.** `AquaProduct` has no draft state and the
  storefront lists every product, so `aquakart_create_product` publishes.
  - New products have `merchantEnabled: false`, which keeps them out of the
    Google Merchant feed, unless the call passes `merchantEnabled: true`.
  - Images: upload each with `aquakart_upload_image` first and pass the
    `mediaIds` (1-10; the first is the main photo). They are stored under
    `Blogs/mcp_<hash>` like blog images, not in the CRM `products/` folder.
  - Description HTML is sanitized with the blog allowlist, and tags are
    stripped from text fields. `discountPrice` must be below `price`, and
    `discountPricePercentage` is computed. `user` is the staff member, as
    the CRM sets it.
  - A duplicate title (case-insensitive) gives `DUPLICATE_TITLE` and a
    duplicate SKU gives `DUPLICATE_SKU`. Category and subcategory are checked
    against the taxonomy.
  - A hidden `mcpOperation` field (`select: false`) records the creating
    operation. A retry after a crash then returns the saved product instead
    of adding a second one.
  - There are no MCP tools to edit or delete products; use the CRM.
- **Coupons are drafts by default.** `status` defaults to `draft`, which
  checkout refuses. Pass `status: "active"` to make a coupon usable at once.
  - Codes are stored uppercase (3-32 letters, digits, `_` or `-`). An
    existing code gives `COUPON_CODE_TAKEN`.
  - Percentage values are capped at 100. `endsAt` must be in the future and
    after `startsAt`, which defaults to now. Product and category ids must
    exist.
  - Coupons cannot be restricted to customer accounts through MCP.
  - `createdBy` and `updatedBy` are the staff member. A hidden `mcpOperation`
    makes retries crash-safe, as for products.
  - Activate, pause or archive coupons in the CRM; there is no MCP update
    tool.
- **Shared images:** replacing a blog's title image never deletes an
  MCP-uploaded image that a product still uses.
- Writes are audited as `mcp.product.create` and `mcp.coupon.create`.

## Category, subcategory and page SEO rules

Source: `src/services/mcp/taxonomySeoTools.js` (logic) and
`src/services/mcp/taxonomySeoSchemas.js` (tool schemas). They work on the
existing `AquaCategory`, `AquaSubCategory` and `AquaSeo` collections and
follow the CRM rules.

- **Permissions:** `categories:read` and `categories:write` reuse
  `products.read` and `products.manage`, because the CRM category routes are
  admin-only. `seo:read` and `seo:write` need `seo.read` and `seo.manage`.
  The write scopes start unticked.
- **Categories:**
  - Create needs 1-5 images from `aquakart_upload_image`; the CRM also
    requires a photo.
  - Titles must be unique (case-insensitive), because the storefront looks
    categories up by title.
  - Renaming returns `TITLE_CHANGED_STOREFRONT_URL`.
  - Text is stored plain, with tags stripped.
  - A delete is refused with `CATEGORY_IN_USE` while subcategories or products
    use the category. Deleting something already gone returns
    `alreadyDeleted: true`.
- **Subcategories:**
  - The parent category must exist, images are optional and titles are
    unique.
  - Moving a subcategory to another category is refused while products use
    it.
  - A delete is refused with `SUBCATEGORY_IN_USE` while products use it.
- **Photos:** `mediaIds` replaces a category's or subcategory's photos. The
  old files are **not** deleted from Cloudinary (the
  `OLD_PHOTOS_KEPT_IN_CLOUDINARY` warning), because they may be shared CRM
  images. A blog's replaced title image is kept if a category or subcategory
  uses it.
- **Page SEO:**
  - Input is validated with the CRM's `buildSeoPayload`:
    - `route` starts with `/`
    - canonical and image URLs are absolute http(s)
    - keywords are de-duplicated
    - `pageKey` is lowercase and unique (`PAGE_KEY_TAKEN`)
  - Updates are partial. Empty strings clear text fields, and the title
    cannot be emptied.
  - There is no hard delete, matching the CRM: `active: false` switches a
    page's SEO off.
  - `aiLocked: true` keeps the weekly AI SEO refresh from changing a page.
    MCP leaves it unchanged unless asked.
- **SEO readiness:** `aquakart_get_seo_readiness` runs the CRM readiness
  report (`src/services/seoReadiness.js`) over every storefront page:
  static pages, products, categories, subcategories and blogs. For each page
  it returns the status, priority, score, missing fields, issues and
  recommended actions, plus the site summary and the next best action.
  CRM admin links are left out.
- **Retries and audit:** all writes are idempotent. Updates and deletes take
  `expectedRevision` (`REVISION_CONFLICT`). A hidden `mcpOperation` field
  makes create retries crash-safe. Writes are audited as
  `mcp.category.*`, `mcp.subcategory.*` and `mcp.seo.*`.

## Blog rules

- Articles are stored as existing `AquaBlog` documents. MCP drafts have:
  - `status: "draft"` and `generatedBy: "ai"`
  - a hidden `integration` block (`select: false`): source `mcp`, client,
    staff member, content hash, operation ids, and who published

  The `generatedBy` enum is unchanged. Public and CRM responses don't include
  the new fields. Every update sets the new `updatedAt` field, which serves as
  the revision.

- **HTML:** sanitized with `sanitize-html` against an allowlist (p, h2-h4,
  lists, tables, links, emphasis, code). There are no images, styles or
  scripts, and `<h1>` becomes `<h2>`. Plain-text fields are stripped of tags.
- **Duplicates:**
  - An identical article (normalized title + text hash, with a unique index)
    is rejected.
  - Same title: `DUPLICATE_TITLE`.
  - An explicit slug that's already taken: `SLUG_TAKEN`. A slug derived from
    the title gets a `-2`, `-3` suffix instead.
- **Updates and images:** only drafts are editable. Partial updates never
  change `titleImages` or `photos`. Replacing a live blog's image needs
  `blogs:publish`.
- **Publish checks:** at least `MCP_PUBLISH_MIN_WORDS` words (default 300), a
  meta description of 50+ characters, a title image, and no other published
  blog with the same slug. The image and meta-description checks can be
  switched off. Publishing is atomic, conditional on the draft's revision, and
  repeating it is a no-op (`alreadyPublished`).
  - `visibleOnStorefront` mirrors `GET /v1/blog-slug/:slug`.
  - The storefront's CDN caches pages for up to 5 minutes.
- **Storefront visibility is unchanged:** public routes filter
  `status ≠ draft`, and draft listings still need a staff token.

## Images

The server never fetches an arbitrary URL. It accepts exactly one of two
input methods per call:

1. **`image` (ChatGPT file param).** Declared with
   `_meta["openai/fileParams"]: ["image"]`.
   - The server downloads `download_url` only over HTTPS, port 443, from
     `MCP_TRUSTED_FILE_HOSTS` (default `*.oaiusercontent.com`).
   - Redirects are limited, each one is re-checked, and the server connects
     only to public IP addresses. The address check happens at connect time,
     which defeats DNS rebinding. There is a size cap and a timeout.
   - **The default host is a guess:** confirm the host ChatGPT actually uses
     from a refused-host log line (`MCP image download refused for untrusted
host <host>`), then set `MCP_TRUSTED_FILE_HOSTS`.
2. **`imageBase64`.** Works with every MCP client, but large images are
   impractical when a model has to emit the bytes as text.
3. **One-time upload URL (preferred for files on disk, e.g. Codex).**
   `aquakart_create_image_upload` returns `uploadUrl`; the client PUTs the raw
   bytes (`curl -T banner.png <uploadUrl>`). The 43-character token in the
   path is the credential (only its SHA-256 is stored, `AquaMcpUpload`), so
   the OAuth token never reaches a shell. One successful upload per URL; it
   expires after `MCP_UPLOAD_URL_TTL_SECONDS` (default 10 minutes); a rejected
   file keeps the URL usable. `aquakart_get_image_upload` returns the status
   and the `mediaId`. Logged as `mcp.upload.completed` / `mcp.upload.failed`
   without the token. A reverse proxy that writes access logs with full URLs
   would record live tokens; they expire quickly and work once.

Format is detected from the file's bytes (JPEG, PNG or WebP); declared types
are ignored. Limits:

- **Blog images:** 5 MB. They are stored as `Blogs/mcp_<sha>` in the existing
  Cloudinary account and de-duplicated by SHA-256 (`AquaMcpMedia`). A
  replaced MCP image is deleted only when no other blog uses it. Staff images
  are never deleted.
- **Branded headers:** `applyBrandLogo: true` overlays the official logo
  already stored in Cloudinary using a Cloudinary transformation (bottom-right
  by default). The logo is never AI-generated.
  - The default logo ids are `logo_nt2v92` (original) and
    `logo-white_rpvptt` (white). Override them with `AQUAKART_LOGO_PUBLIC_ID`
    and `AQUAKART_LOGO_WHITE_PUBLIC_ID`, or set `none` to turn overlays off
    (`LOGO_NOT_CONFIGURED`).
  - `logoVariant: "white"` uses the white logo for dark images.

## Logo references for AI-generated images

- `aquakart_get_brand_assets` needs no scope; any signed-in connection can
  call it. The server's MCP `instructions` tell clients to call it before
  creating a branded image.
- **What it returns:**
  - for each logo (original and white): `url`, the clean PNG to use as
    the reference, and `previewUrl`, the round badge with a red border on
    a dark background. The badge is shown on the consent page and must not
    be copied.
  - rules: never redraw, recolour or distort the logo; use the original on
    light backgrounds and the white logo on dark ones; keep clear space
  - how to get the exact logo on a blog image: generate the image without
    a logo, upload it, then attach with `applyBrandLogo`
- **Files:** clean logos are
  `https://res.cloudinary.com/aquakartproducts/image/upload/v1793926813/logo_nt2v92.png`
  and `.../logo-white_rpvptt.png`. Override them with `MCP_BRAND_LOGO_URL` and
  `MCP_BRAND_LOGO_WHITE_URL`.
- **Limits:** image models may still distort a logo they are shown. Only the
  overlay guarantees the exact file. Instagram uploads have no overlay
  option, so a logo in an Instagram creative is only as accurate as the
  model that made it.

The consent page shows the badge logo: white in dark mode, original
otherwise (`MCP_CONSENT_LOGO_URL` and `MCP_CONSENT_LOGO_WHITE_URL`). Its CSP
allows images only from the logo's host.

## Instagram publishing

**Meta setup:**

- An Instagram Professional (Business or Creator) account.
- A Meta app with the Instagram API. Use either option:
  - Facebook Login (`graph.facebook.com`): `instagram_basic`,
    `instagram_content_publish` and `pages_read_engagement`
  - Instagram Login (`graph.instagram.com`): `instagram_business_basic` and
    `instagram_business_content_publish`
- Set `INSTAGRAM_USER_ID`, `INSTAGRAM_ACCESS_TOKEN` (long-lived),
  `INSTAGRAM_GRAPH_BASE_URL` and `INSTAGRAM_GRAPH_API_VERSION`. The default
  `v26.0` is unverified; check Meta's changelog.
- The token is sent only in the `Authorization` header and never logged.
  Long-lived tokens expire after about 60 days and are **not** refreshed
  automatically. When that happens, tools answer `INSTAGRAM_TOKEN_INVALID`.

**Temporary storage:** creatives go to `aquakart/instagram-temp/ig_<sha>`
(tag `aquakart-instagram-temp`).

- Meta receives a JPEG rendition, because Instagram accepts JPEG only. The
  limits are 8 MB, at least 320 px wide, and an aspect ratio from 4:5 to
  1.91:1.
- Records are kept in `AquaInstagramAsset`, one per image hash, so the same
  creative can't be posted twice (`ALREADY_POSTED`).

**Lifecycle** (`src/models/mcp/instagramAsset.js`):

```text
UPLOADED → CONTAINER_CREATED → PROCESSING → READY → PUBLISHING
        → PUBLISHED_VERIFIED → CLEANUP_PENDING → CLEANED
   side states: FAILED (container ERROR/EXPIRED; kept, retry makes a new container)
                PUBLISH_UNCERTAIN (publish result lost; reconciled, never re-posted blindly)
```

**Retry and reconciliation rules:**

- **Container:** the container id is saved before polling. Polling is
  bounded (`INSTAGRAM_CONTAINER_POLL_*`). If the container is still
  processing, the tool returns `CONTAINER_PROCESSING`, and a retry keeps
  polling the same container.
- **Publish:** `PUBLISHING` is saved before `media_publish` is called.
  - If Meta refuses outright (rate limit, bad token, or a rejected request),
    the asset goes back to `READY`; nothing was posted.
  - If the call times out, the connection drops, or Meta returns a 5xx, the
    asset becomes `PUBLISH_UNCERTAIN` and is reconciled.
- **Reconciling:** the server checks the container's status.
  - `PUBLISHED`: it finds the media in recent posts (matching caption and
    time) and verifies it.
  - `FINISHED`: nothing was posted, so a retry may publish.
  - Meta unreachable: the outcome stays unknown and **no retry posts again**.
- **Verification:** the post is verified with `GET /{media-id}`. One write
  then records `PUBLISHED_VERIFIED` → `CLEANUP_PENDING` together with the
  media id, permalink and `cleanupAfter`, before success is returned.
- **Partial failures:** if that write fails, the asset stays `PUBLISHING`
  with its media id. A retry after the publish lease expires (or the worker)
  reconciles it without posting again.
- **Concurrency:** a publish lease (`publishLockedUntil`) prevents parallel
  publishes of one asset.

## Cleanup worker

`startInstagramCleanupWorker` in `src/services/mcp/index.js` is started by
`index.js` only when MCP and Instagram are configured. Every
`INSTAGRAM_CLEANUP_POLL_SECONDS` (default 60) it does this:

1. Claims due cleanups with a 5-minute lease. A cleanup is due when its
   status is `CLEANUP_PENDING` and `cleanupAfter` (publication time + 30
   minutes by default, `INSTAGRAM_CLEANUP_DELAY_MINUTES`) has passed.
2. Re-checks the database state and, by default, that the Instagram media
   still exists (`INSTAGRAM_CLEANUP_VERIFY_REMOTE`).
3. Deletes the exact recorded public id. The id must match
   `aquakart/instagram-temp/ig_<32 hex>`; the adapter refuses anything else.
4. Records the result:
   - Cloudinary `not found` counts as cleaned, so a crash after the delete is
     safe.
   - Failures back off exponentially (1, 2, 4 … minutes, capped at 1 h), up
     to `INSTAGRAM_CLEANUP_MAX_ATTEMPTS` (default 8, then `failed`).
   - A missing Instagram post marks the asset `blocked` for manual review.
5. Reconciles `PUBLISH_UNCERTAIN` and stale `PUBLISHING` assets (up to 20
   attempts each). Reconciling never publishes.

**Why a worker is needed:** cleanup has to happen after a delay without the
MCP client staying connected. All its state is in MongoDB, so it resumes after
restarts and is safe with several instances.

**Manual cleanup:** `aquakart_cleanup_instagram_asset` works only on verified
posts (which it cleans immediately) or on uploads that were never sent to
Meta.

## Scheduling (ChatGPT / Claude)

The intended daily run, for example 8:30 AM IST, is a client-side scheduled
task: generate the content, then call the tools. The backend adds no schedule
for it.

**Blocker: unverified compatibility.** OpenAI documents that scheduled tasks
run unattended and may use connected apps. As of 2026-11-05 it does not
document whether these work in an unattended run:

- a developer-mode custom MCP connector
- write actions without an approval prompt
- passing a ChatGPT-generated image as a file param

**Automated publishing is unverified** until a real scheduled run creates,
illustrates and publishes a test blog and an Instagram post end to end.
Claude's scheduling and image handling have to be checked the same way.

**Stopping the Gemini job before ChatGPT publishing goes live:** turn off the
built-in Gemini job so there aren't two daily blogs.

1. In the CRM, open Scheduled jobs → "AI blog drafts" (`blog-ai-drafts`).
2. Disable it, or call `PATCH /v1/crm/jobs/:id` with `{ "enabled": false }`
   using a `jobs.manage` staff token.

`BLOG_AI_DRAFTS_ENABLED` only seeds a new database, so it doesn't turn off an
existing job. Re-enable the job to go back to Gemini.

## Deployment checklist

1. Set `MCP_PUBLIC_BASE_URL`, plus the optional `MCP_*`, `INSTAGRAM_*` and
   `AQUAKART_LOGO_PUBLIC_ID` variables, through Doppler or the deploy env
   (see `.env.example`). Never put them in the image.
2. Serve the API over HTTPS. Forward the root OAuth paths (see Endpoints). Set
   `TRUST_PROXY` so per-IP rate limits see real client addresses.
3. Run `npm ci`; this adds `@modelcontextprotocol/sdk`, `zod` and
   `sanitize-html`. Restart the app. Mongoose builds the new indexes,
   including a unique partial index on `AquaBlog.integration.contentHash`.
4. Grant `instagram.publish` to the staff role that will authorize Instagram.
5. Connect with MCP Inspector or Claude Code first. Check `tools/list`, then
   create a draft on a **non-production** database.
6. Connect ChatGPT. Upload one image and confirm the `download_url` host
   (update `MCP_TRUSTED_FILE_HOSTS`).
7. Get explicit approval before the first real publish or Instagram post.
8. Disable the Gemini blog job (above) only when client-side scheduled
   publishing is verified.

## Known limitations

- Rate limiting is in memory, per instance.
- DCR registration is open but rate-limited: 20 per hour per IP, with
  allowlisted redirects only.
- Abandoned MCP blog uploads (never attached) and never-posted Instagram
  uploads are not deleted automatically. Use the cleanup tool for Instagram
  uploads.
- Carousels, reels and stories are not supported.
- The Instagram token is not refreshed automatically.
- The Meta API version and the ChatGPT file host still need confirming (see
  above).
