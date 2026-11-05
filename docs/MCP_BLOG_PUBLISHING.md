# Aquakart MCP server: blog and Instagram publishing

Last reviewed: 2026-11-05 (Asia/Calcutta). Verify details in source:
`src/routes/mcp.js`, `src/services/mcp/`, `src/models/mcp/`,
`src/validators/mcp/blog.js`. Tests: `test/mcpServer.test.js`,
`test/mcpBlogTools.test.js`, `test/mcpInstagram.test.js`,
`test/blogRoutesRegression.test.js`.

A remote MCP server lets an authorized MCP client (ChatGPT, Claude, Claude
Code, MCP Inspector) do these jobs:

- read blogs
- create and edit blog drafts
- upload and attach blog images
- publish blogs
- post images to the Aquakart Instagram account

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

  Super-admin and legacy role 1 have every permission.

- **Scopes:** `blogs:read`, `blogs:write`, `media:upload`, `blogs:publish`,
  `instagram:read`, `instagram:upload`, `instagram:publish`,
  `instagram:cleanup`. Publish and cleanup scopes start unticked on the consent
  page, so granting them is always a deliberate choice. No scope reaches
  customers, orders, payments or other CRM data.
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
- **Local testing:** MCP Inspector (`npx @modelcontextprotocol/inspector`)
  against `http://localhost:5300/v1/mcp` with
  `MCP_PUBLIC_BASE_URL=http://localhost:5300`. This writes to whatever
  database `.env` points at, so use a non-production DB.

## Tools

All tools have strict input schemas (unknown arguments are rejected), output
schemas, `annotations` (read-only, destructive and open-world hints) and
`_meta.securitySchemes`. Every write takes an `idempotencyKey`. Reuse the
same key when retrying after a timeout.

Results:

- **Success:** `structuredContent = { ok: true, …, correlationId, operationId?, replayed? }`
- **Failure:** `isError: true` with `{ ok: false, error: { code, message, details?, retryable? }, correlationId, operationId? }`

A missing scope returns `INSUFFICIENT_SCOPE` plus
`_meta["mcp/www_authenticate"]`, which prompts the client to re-authorize.

| Tool                               | Scope               | Input (main fields)                                                                                       | Output (main fields)                                                          |
| ---------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `aquakart_list_blogs`              | `blogs:read`        | `status` draft/published/all, `query`, `page`, `limit≤50`                                                 | `blogs[]` (id, title, slug, status, revision, publicUrl)                      |
| `aquakart_get_blog`                | `blogs:read`        | `blogId` or `slug`                                                                                        | `blog` with HTML, SEO fields, references, images                              |
| `aquakart_get_blog_status`         | `blogs:read`        | `blogId` or `slug`                                                                                        | `status`, `publicUrl`, `visibleOnStorefront`, `revision`                      |
| `aquakart_create_blog`             | `blogs:write`       | `idempotencyKey`, `title` (10-120), `description` (HTML), optional slug/SEO/taxonomy fields, `modelUsed`  | `blog` (always `draft`), `warnings`                                           |
| `aquakart_update_blog`             | `blogs:write`       | `idempotencyKey`, `blogId`, `expectedRevision?`, any content field (null clears)                          | `blog`                                                                        |
| `aquakart_upload_image`            | `media:upload`      | `idempotencyKey`, `image` (ChatGPT file) **or** `imageBase64`                                             | `media` (`mediaId`, `publicId`, `secure_url`), `deduplicated`                 |
| `aquakart_attach_image`            | `blogs:write`       | `idempotencyKey`, `blogId`, `mediaId`, `applyBrandLogo?`, `expectedRevision?`                             | `blog`, `titleImage` `{ id, secure_url }`                                     |
| `aquakart_publish_blog`            | `blogs:publish`     | `idempotencyKey`, `blogId`, `expectedRevision?`                                                           | `blog`, `publicUrl`, `alreadyPublished`, `visibleOnStorefront`                |
| `aquakart_upload_instagram_image`  | `instagram:upload`  | `idempotencyKey`, `image` or `imageBase64`                                                                | `asset` (`assetId`, status, cleanup fields), `deduplicated`                   |
| `aquakart_publish_instagram`       | `instagram:publish` | `idempotencyKey`, `assetId`, `caption` (≤2,200 chars, ≤30 hashtags, ≤20 mentions, plain text), `altText?` | `asset` (`instagramMediaId`, `permalink`, `cleanupAfter`), `alreadyPublished` |
| `aquakart_get_instagram_status`    | `instagram:read`    | `assetId`                                                                                                 | `asset`                                                                       |
| `aquakart_list_instagram_posts`    | `instagram:read`    | `status?`, `page`, `limit≤50`                                                                             | `assets[]`                                                                    |
| `aquakart_cleanup_instagram_asset` | `instagram:cleanup` | `idempotencyKey`, `assetId`                                                                               | `asset`, `cleaned`, `alreadyCleaned`                                          |

Run `tools/list` for the full JSON Schemas.

Common error codes:

- **Validation and references:** `VALIDATION_FAILED`, `INVALID_REFERENCE`
- **Duplicates:** `DUPLICATE_CONTENT`, `DUPLICATE_TITLE`, `SLUG_TAKEN`
- **Concurrency and idempotency:** `REVISION_CONFLICT`,
  `IDEMPOTENCY_KEY_REUSED`, `OPERATION_IN_PROGRESS`
- **Blogs:** `BLOG_NOT_FOUND`, `BLOG_NOT_DRAFT`, `PUBLISH_CHECKS_FAILED`
  (details list the failed checks)
- **Images:** `UNSUPPORTED_IMAGE_TYPE`, `IMAGE_TOO_LARGE`,
  `UNTRUSTED_IMAGE_SOURCE`, `IMAGE_DOWNLOAD_FAILED`, `MEDIA_NOT_FOUND`,
  `LOGO_NOT_CONFIGURED`
- **Instagram:** `INSTAGRAM_NOT_CONFIGURED`, `INSTAGRAM_TOKEN_INVALID`,
  `META_TIMEOUT`, `META_RATE_LIMITED`, `CONTAINER_PROCESSING`,
  `CONTAINER_FAILED`, `PUBLISH_UNCERTAIN`, `PUBLISH_UNVERIFIED`,
  `ALREADY_POSTED`, `INVALID_ASPECT_RATIO`, `INVALID_CAPTION`
- **Cleanup:** `CLEANUP_NOT_ALLOWED`, `CLEANUP_FAILED`
- **General:** `STORAGE_UNAVAILABLE`, `INTERNAL_ERROR`

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

Format is detected from the file's bytes (JPEG, PNG or WebP); declared types
are ignored. Limits:

- **Blog images:** 5 MB. They are stored as `Blogs/mcp_<sha>` in the existing
  Cloudinary account and de-duplicated by SHA-256 (`AquaMcpMedia`). A
  replaced MCP image is deleted only when no other blog uses it. Staff images
  are never deleted.
- **Branded headers:** `applyBrandLogo: true` overlays the official logo
  already stored in Cloudinary (`AQUAKART_LOGO_PUBLIC_ID`) using a Cloudinary
  transformation. The logo is never AI-generated.

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
