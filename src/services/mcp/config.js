// Aquakart MCP server settings, all from the environment (or Doppler).
// The server is off unless MCP_PUBLIC_BASE_URL is set: it is the public
// HTTPS origin of this API, used as the OAuth issuer and to build the MCP
// resource URL (<origin>/v1/mcp) that tokens are bound to.

export const MCP_PATH = "/v1/mcp";
export const MCP_SCOPES = {
  read: "blogs:read",
  write: "blogs:write",
  upload: "media:upload",
  publish: "blogs:publish",
  igRead: "instagram:read",
  igUpload: "instagram:upload",
  igPublish: "instagram:publish",
  igCleanup: "instagram:cleanup",
  productsRead: "products:read",
  productsWrite: "products:write",
  couponsRead: "coupons:read",
  couponsWrite: "coupons:write",
  categoriesRead: "categories:read",
  categoriesWrite: "categories:write",
  seoRead: "seo:read",
  seoWrite: "seo:write",
};
export const MCP_SCOPE_LIST = Object.values(MCP_SCOPES);
export const MCP_SCOPE_LABELS = {
  "blogs:read": "Read blogs, including drafts",
  "blogs:write": "Create and edit blog drafts and set their title images",
  "media:upload": "Upload blog images to Aquakart's image storage",
  "blogs:publish": "Publish blogs to the live Aquakart website",
  "instagram:read": "See Instagram creatives and publishing history",
  "instagram:upload": "Upload Instagram creatives to temporary storage",
  "instagram:publish": "Post to the Aquakart Instagram account",
  "instagram:cleanup": "Delete temporary Instagram creatives",
  "products:read":
    "Read the product catalogue (no dealer prices or reviewer details)",
  "products:write":
    "Add new products; they appear on the live website immediately",
  "coupons:read": "Read coupons and their usage counts",
  "coupons:write":
    "Create coupons (draft by default; active ones apply at checkout)",
  "categories:read": "Read categories and subcategories",
  "categories:write":
    "Create, edit and delete categories and subcategories on the live website",
  "seo:read": "Read page SEO settings and the SEO readiness report",
  "seo:write":
    "Create and edit page SEO settings (titles, descriptions, canonical, social tags) on the live website",
};
// The CRM permission a staff member needs before they can grant a scope.
// Scopes cover blogs, Instagram, the product catalogue, categories, coupons
// and page SEO only:
// never customers, orders or payments. products.* are admin-only by default
// (super-admin / role 1), matching the CRM product routes (checkAdmin).
export const SCOPE_PERMISSIONS = {
  "blogs:read": "blogs.manage",
  "blogs:write": "blogs.manage",
  "media:upload": "blogs.manage",
  "blogs:publish": "blogs.manage",
  "instagram:read": "instagram.publish",
  "instagram:upload": "instagram.publish",
  "instagram:publish": "instagram.publish",
  "instagram:cleanup": "instagram.publish",
  "products:read": "products.read",
  "products:write": "products.manage",
  "coupons:read": "coupons.read",
  "coupons:write": "coupons.manage",
  // Category/subcategory routes are admin-only in the CRM (checkAdmin).
  "categories:read": "products.read",
  "categories:write": "products.manage",
  "seo:read": "seo.read",
  "seo:write": "seo.manage",
};
// OAuth callbacks of supported MCP clients: ChatGPT (stable RFC 9207 URI and
// per-connector callback ids) and Claude. Claude Code and other native
// clients use loopback redirects (see allowLoopbackRedirects). A trailing *
// is a prefix match.
const DEFAULT_REDIRECTS = [
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/*",
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
].join(",");
// Hosts ChatGPT serves file-param download_url links from. Confirm against
// a real call before production; see docs/MCP_BLOG_PUBLISHING.md.
const DEFAULT_FILE_HOSTS = "*.oaiusercontent.com";

// Official Aquakart logo files in the aquakartproducts Cloudinary account.
const LOGO_BASE = "https://res.cloudinary.com/aquakartproducts/image/upload";
const BADGE = "w_1000,c_fill,ar_1:1,g_auto,r_max,bo_5px_solid_red,b_rgb:262c35";
export const DEFAULT_BRAND = {
  logoId: "logo_nt2v92",
  logoWhiteId: "logo-white_rpvptt",
  logoUrl: `${LOGO_BASE}/v1793926813/logo_nt2v92.png`,
  logoWhiteUrl: `${LOGO_BASE}/v1793926813/logo-white_rpvptt.png`,
  badgeUrl: `${LOGO_BASE}/${BADGE}/v1793926813/logo_nt2v92.png`,
  badgeWhiteUrl: `${LOGO_BASE}/${BADGE}/v1793926813/logo-white_rpvptt.png`,
};
const logoId = (value, fallback) => {
  const id = String(value || "").trim();
  if (id.toLowerCase() === "none") return null;
  return id || fallback;
};
const httpsUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.href : null;
  } catch (_error) {
    return null;
  }
};

const positive = (value, fallback, max = Infinity) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(number, max)
    : fallback;
};
const flag = (value, fallback) =>
  value === undefined || value === ""
    ? fallback
    : String(value).toLowerCase() === "true";
const csv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const origin = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      return null;
    return url.origin;
  } catch (_error) {
    return null;
  }
};

export const loadMcpConfig = (env = process.env) => {
  const baseUrl = origin(env.MCP_PUBLIC_BASE_URL);
  const storefront =
    origin(
      env.MCP_STOREFRONT_URL || env.FRONTEND_PUBLIC_URL || env.FRONTEND_URL,
    ) || "https://aquakart.co.in";
  return {
    enabled: Boolean(baseUrl),
    baseUrl,
    issuerUrl: baseUrl ? `${baseUrl}/` : null,
    resourceUrl: baseUrl ? `${baseUrl}${MCP_PATH}` : null,
    storefrontUrl: storefront,
    allowedRedirectUris: csv(
      env.MCP_OAUTH_ALLOWED_REDIRECT_URIS || DEFAULT_REDIRECTS,
    ),
    // RFC 8252 loopback redirects (http://localhost:<port>/...) for native
    // clients such as Claude Code; PKCE still applies. Set false to block.
    allowLoopbackRedirects: flag(env.MCP_OAUTH_ALLOW_LOOPBACK_REDIRECTS, true),
    accessTokenTtlSeconds: Math.trunc(
      positive(env.MCP_ACCESS_TOKEN_TTL_SECONDS, 3600, 86400),
    ),
    refreshTokenTtlSeconds: Math.trunc(
      positive(env.MCP_REFRESH_TOKEN_TTL_DAYS, 30, 365) * 24 * 3600,
    ),
    rateLimitPerMinute: Math.trunc(
      positive(env.MCP_RATE_LIMIT_PER_MINUTE, 60, 10000),
    ),
    trustedFileHosts: csv(env.MCP_TRUSTED_FILE_HOSTS || DEFAULT_FILE_HOSTS).map(
      (h) => h.toLowerCase(),
    ),
    imageMaxBytes: Math.trunc(
      positive(env.MCP_IMAGE_MAX_BYTES, 5 * 1024 * 1024, 15 * 1024 * 1024),
    ),
    publishMinWords: Math.trunc(
      positive(env.MCP_PUBLISH_MIN_WORDS, 300, 20000),
    ),
    publishRequireTitleImage: flag(env.MCP_PUBLISH_REQUIRE_TITLE_IMAGE, true),
    publishRequireShortDescription: flag(
      env.MCP_PUBLISH_REQUIRE_SHORT_DESCRIPTION,
      true,
    ),
    // Trusted logo already stored in Cloudinary (never AI-generated).
    // Defaults to the official Aquakart logo; "none" turns overlays off.
    logoPublicId: logoId(env.AQUAKART_LOGO_PUBLIC_ID, DEFAULT_BRAND.logoId),
    logoWhitePublicId: logoId(
      env.AQUAKART_LOGO_WHITE_PUBLIC_ID,
      DEFAULT_BRAND.logoWhiteId,
    ),
    brand: {
      name: "Aquakart",
      // Clean files: the reference for anyone reproducing the logo.
      logoUrl: httpsUrl(env.MCP_BRAND_LOGO_URL) || DEFAULT_BRAND.logoUrl,
      logoWhiteUrl:
        httpsUrl(env.MCP_BRAND_LOGO_WHITE_URL) || DEFAULT_BRAND.logoWhiteUrl,
      // Round badge renditions shown on the consent page.
      badgeUrl: httpsUrl(env.MCP_CONSENT_LOGO_URL) || DEFAULT_BRAND.badgeUrl,
      badgeWhiteUrl:
        httpsUrl(env.MCP_CONSENT_LOGO_WHITE_URL) || DEFAULT_BRAND.badgeWhiteUrl,
    },
    logoGravity: String(env.MCP_LOGO_GRAVITY || "south_east").trim(),
    logoWidthRatio: positive(env.MCP_LOGO_WIDTH_RATIO, 0.18, 0.5),
    operationLockMs: Math.trunc(
      positive(env.MCP_OPERATION_LOCK_SECONDS, 120, 3600) * 1000,
    ),
    instagram: loadInstagramConfig(env),
  };
};

// Meta Instagram Content Publishing. Tools report INSTAGRAM_NOT_CONFIGURED
// until the account id and token are set. The token is only ever sent in
// an Authorization header, never in URLs or logs.
export const INSTAGRAM_TEMP_FOLDER = "aquakart/instagram-temp";
export const loadInstagramConfig = (env = process.env) => {
  const userId = String(env.INSTAGRAM_USER_ID || "").trim();
  const accessToken = String(env.INSTAGRAM_ACCESS_TOKEN || "").trim();
  return {
    configured: /^\d{5,30}$/.test(userId) && accessToken.length >= 20,
    userId,
    accessToken,
    // graph.facebook.com for Instagram API with Facebook Login;
    // graph.instagram.com for Instagram API with Instagram Login.
    graphBaseUrl: [
      "https://graph.facebook.com",
      "https://graph.instagram.com",
    ].includes(env.INSTAGRAM_GRAPH_BASE_URL)
      ? env.INSTAGRAM_GRAPH_BASE_URL
      : "https://graph.facebook.com",
    apiVersion: /^v\d{1,3}\.\d$/.test(env.INSTAGRAM_GRAPH_API_VERSION || "")
      ? env.INSTAGRAM_GRAPH_API_VERSION
      : "v26.0",
    requestTimeoutMs: Math.trunc(
      positive(env.INSTAGRAM_REQUEST_TIMEOUT_SECONDS, 20, 120) * 1000,
    ),
    containerPollAttempts: Math.trunc(
      positive(env.INSTAGRAM_CONTAINER_POLL_ATTEMPTS, 8, 30),
    ),
    containerPollIntervalMs: Math.trunc(
      positive(env.INSTAGRAM_CONTAINER_POLL_INTERVAL_SECONDS, 3, 60) * 1000,
    ),
    imageMaxBytes: Math.trunc(
      positive(env.INSTAGRAM_IMAGE_MAX_BYTES, 8 * 1024 * 1024, 8 * 1024 * 1024),
    ),
    cleanupDelayMs: Math.trunc(
      positive(env.INSTAGRAM_CLEANUP_DELAY_MINUTES, 30, 7 * 24 * 60) *
        60 *
        1000,
    ),
    cleanupPollMs: Math.trunc(
      positive(env.INSTAGRAM_CLEANUP_POLL_SECONDS, 60, 3600) * 1000,
    ),
    cleanupMaxAttempts: Math.trunc(
      positive(env.INSTAGRAM_CLEANUP_MAX_ATTEMPTS, 8, 50),
    ),
    cleanupVerifyRemote: flag(env.INSTAGRAM_CLEANUP_VERIFY_REMOTE, true),
    workerEnabled: flag(env.INSTAGRAM_CLEANUP_WORKER_ENABLED, true),
  };
};

// Exact match, or prefix match for entries ending in "*".
export const redirectUriAllowed = (uri, config) => {
  if (typeof uri !== "string") return false;
  let url;
  try {
    url = new URL(uri);
  } catch (_error) {
    return false;
  }
  if (url.hash) return false;
  if (
    config.allowLoopbackRedirects &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  ) {
    return true;
  }
  return config.allowedRedirectUris.some((allowed) =>
    allowed.endsWith("*")
      ? uri.startsWith(allowed.slice(0, -1)) &&
        /^[A-Za-z0-9._~-]+$/.test(uri.slice(allowed.length - 1))
      : uri === allowed,
  );
};
