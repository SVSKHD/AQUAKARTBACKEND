import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { MCP_SCOPES } from "./config.js";
import { toBlogToolError } from "./errors.js";
import { IDEMPOTENCY_KEY, OBJECT_ID, SLUG } from "../../validators/mcp/blog.js";

// Tool catalogue of the Aquakart MCP server. One McpServer is built per
// HTTP request (stateless Streamable HTTP) with the caller's verified
// OAuth identity. Every tool:
// - has a strict input schema (unknown arguments are rejected) and an
//   output schema for its structured result
// - names its OAuth scopes (securitySchemes) and enforces them on call;
//   a missing scope returns INSUFFICIENT_SCOPE plus an OAuth step-up hint
// - returns { ok: true, ...data, correlationId } or an isError result with
//   { ok: false, error: { code, message, details? }, correlationId }

const objectId = z.string().regex(OBJECT_ID, "must be a 24-character id");
const idempotencyKey = z
  .string()
  .regex(IDEMPOTENCY_KEY, "8-128 letters, digits, '.', '_', ':' or '-'")
  .describe(
    "Unique per intended action (e.g. blog-2026-11-06). Reuse the SAME key when retrying after a timeout; never reuse it for a different action.",
  );
const expectedRevision = z
  .string()
  .max(40)
  .optional()
  .describe(
    "Revision from your last read; the call fails with REVISION_CONFLICT if the blog changed since.",
  );
const textList = (maxItems, maxChars) =>
  z.array(z.string().max(maxChars)).max(maxItems);

// ChatGPT file param (Apps SDK "openai/fileParams"); all four properties
// must be declared. The server downloads download_url from trusted hosts only.
const fileParam = z
  .object({
    download_url: z.string().url(),
    file_id: z.string().min(1).max(256),
    mime_type: z.string().max(100).optional(),
    file_name: z.string().max(255).optional(),
  })
  .describe("Image file provided by the MCP host (ChatGPT file param).");
const imageBase64 = z
  .string()
  .min(16)
  .max(12 * 1024 * 1024)
  .describe(
    "Base64 image bytes (JPEG/PNG/WebP) for clients without file params, e.g. Claude. Optional data: prefix.",
  );

const contentFields = {
  shortDescription: z
    .string()
    .max(320)
    .describe("Meta description, ideally 140-160 characters."),
  summary: z.string().max(2000),
  keywords: textList(30, 80),
  keyphrases: textList(15, 120),
  keyHighlights: textList(10, 300),
  tags: textList(20, 60),
  notes: z.string().max(300).describe("Editor note; not shown publicly."),
  brand: z.string().min(1).max(60),
  category: objectId.nullable().describe("AquaCategory id or null"),
  subCategory: objectId
    .nullable()
    .describe("AquaSubCategory id under the category, or null"),
  product: objectId.nullable().describe("AquaProduct id or null"),
};
const optionalShape = (shape) =>
  Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, schema.optional()]),
  );

const blogSummary = z.object({
  blogId: z.string(),
  title: z.string(),
  slug: z.string().nullable(),
  status: z.enum(["draft", "published"]),
  createdAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  hasTitleImage: z.boolean(),
  source: z.string(),
  revision: z.string(),
  publicUrl: z.string().nullable(),
});
const media = z.object({ id: z.string(), secure_url: z.string() });
const blogFull = blogSummary.extend({
  description: z.string(),
  shortDescription: z.string(),
  summary: z.string(),
  keywords: z.string(),
  keyphrases: z.string(),
  keyHighlights: z.array(z.string()),
  tags: z.array(z.string()),
  notes: z.string(),
  brand: z.string(),
  category: z.string().nullable(),
  subCategory: z.string().nullable(),
  product: z.string().nullable(),
  titleImages: z.array(media),
  photos: z.array(media),
  wordCount: z.number(),
});
const igAsset = z.object({
  assetId: z.string(),
  status: z.string(),
  cloudinaryPublicId: z.string(),
  imageUrl: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  caption: z.string().nullable(),
  instagramMediaId: z.string().nullable(),
  permalink: z.string().nullable(),
  publishedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  cleanupStatus: z.string(),
  cleanupAfter: z.string().nullable(),
  cleanedAt: z.string().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: z.string().nullable(),
});
const envelope = (shape, write = false) =>
  z.object({
    ok: z.literal(true),
    correlationId: z.string(),
    ...(write ? { operationId: z.string(), replayed: z.boolean() } : {}),
    ...shape,
  });

const lookupInput = z
  .strictObject({
    blogId: objectId.optional(),
    slug: z.string().regex(SLUG).max(80).optional(),
  })
  .refine((value) => Boolean(value.blogId) !== Boolean(value.slug), {
    message: "Provide exactly one of blogId or slug",
  });
const imageInput = (extra = {}) =>
  z
    .strictObject({
      idempotencyKey,
      image: fileParam.optional(),
      imageBase64: imageBase64.optional(),
      ...extra,
    })
    .refine((value) => Boolean(value.image) !== Boolean(value.imageBase64), {
      message: "Provide exactly one of image or imageBase64",
    });

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

export const TOOL_SCOPES = {};

export const createAquakartMcpServer = ({
  blogTools,
  instagramTools,
  auth,
  correlationId,
  resourceMetadataUrl,
  log = console,
}) => {
  const server = new McpServer(
    { name: "aquakart", title: "Aquakart", version: "1.0.0" },
    {
      instructions:
        "Aquakart blog and Instagram publishing. Blogs: create a draft, upload and attach a title image, then publish with aquakart_publish_blog. Instagram: upload a creative, then publish it with a caption. Always send an idempotencyKey on writes and reuse it when retrying.",
    },
  );

  const reply = (body, isError = false, meta) => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    ...(meta ? { _meta: meta } : {}),
  });

  const register = (
    name,
    { title, description, scopes, input, output, annotations, meta = {} },
    handler,
  ) => {
    TOOL_SCOPES[name] = scopes;
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: input,
        outputSchema: output,
        annotations,
        _meta: { securitySchemes: [{ type: "oauth2", scopes }], ...meta },
      },
      async (args) => {
        const started = Date.now();
        const missing = scopes.filter((scope) => !auth.scopes.includes(scope));
        let body;
        let isError = false;
        let meta2;
        if (missing.length) {
          isError = true;
          body = {
            ok: false,
            error: {
              code: "INSUFFICIENT_SCOPE",
              message: `This connection lacks ${missing.join(", ")}; reconnect and grant it`,
              details: { missing },
            },
            correlationId,
          };
          meta2 = {
            "mcp/www_authenticate": [
              `Bearer error="insufficient_scope", error_description="Requires ${missing.join(" ")}", scope="${[...new Set([...auth.scopes, ...missing])].join(" ")}", resource_metadata="${resourceMetadataUrl}"`,
            ],
          };
        } else {
          try {
            body = {
              ok: true,
              ...(await handler(args, { auth, correlationId })),
              correlationId,
            };
          } catch (caught) {
            const error = toBlogToolError(caught);
            isError = true;
            body = {
              ok: false,
              error: {
                code: error.code,
                message: error.message,
                ...(error.details !== undefined
                  ? { details: error.details }
                  : {}),
                ...(caught?.retryable !== undefined ||
                error.retryable !== undefined
                  ? { retryable: Boolean(caught?.retryable ?? error.retryable) }
                  : {}),
              },
              ...(caught?.operationId
                ? { operationId: caught.operationId }
                : {}),
              correlationId,
            };
            if (error.code === "INTERNAL_ERROR" && caught !== error) {
              log.error(`MCP tool ${name} failed:`, caught?.message || caught);
            }
          }
        }
        // Structured audit line: identity, tool, result. No arguments/tokens.
        log.log(
          JSON.stringify({
            event: "mcp.tool",
            tool: name,
            clientId: auth.clientId,
            adminUser: auth.adminUserId,
            correlationId,
            ok: !isError,
            code: isError ? body.error.code : undefined,
            operationId: body.operationId,
            replayed: body.replayed,
            durationMs: Date.now() - started,
          }),
        );
        return reply(body, isError, meta2);
      },
    );
  };

  // ---- Blogs ---------------------------------------------------------
  register(
    "aquakart_list_blogs",
    {
      title: "List blogs",
      description:
        "List Aquakart blogs (drafts and published) with title, slug, status and public URL. Newest first.",
      scopes: [MCP_SCOPES.read],
      input: z.strictObject({
        status: z.enum(["draft", "published", "all"]).optional(),
        query: z
          .string()
          .max(100)
          .optional()
          .describe("Case-insensitive title search"),
        page: z.number().int().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      output: envelope({
        blogs: z.array(blogSummary),
        page: z.number(),
        limit: z.number(),
        total: z.number(),
      }),
      annotations: READ,
    },
    (args) => blogTools.listBlogs(args),
  );
  register(
    "aquakart_get_blog",
    {
      title: "Get blog",
      description:
        "Get one blog's full article (HTML), SEO fields, references, images and revision by blogId or slug.",
      scopes: [MCP_SCOPES.read],
      input: lookupInput,
      output: envelope({ blog: blogFull }),
      annotations: READ,
    },
    (args) => blogTools.getBlog(args),
  );
  register(
    "aquakart_get_blog_status",
    {
      title: "Get blog status",
      description:
        "Publication status, revision, public URL and whether the storefront serves this blog for its slug.",
      scopes: [MCP_SCOPES.read],
      input: lookupInput,
      output: envelope({
        blogId: z.string(),
        title: z.string(),
        slug: z.string().nullable(),
        status: z.enum(["draft", "published"]),
        publishedAt: z.string().nullable(),
        revision: z.string(),
        hasTitleImage: z.boolean(),
        publicUrl: z.string().nullable(),
        visibleOnStorefront: z.boolean(),
      }),
      annotations: READ,
    },
    (args) => blogTools.getBlogStatus(args),
  );
  register(
    "aquakart_create_blog",
    {
      title: "Create blog draft",
      description:
        "Save a new SEO article as a DRAFT (never published by this tool). HTML is sanitized to an allowlist (p, h2-h4, lists, tables, links, emphasis; no images/scripts/styles). Rejects duplicate content, duplicate titles and taken slugs.",
      scopes: [MCP_SCOPES.write],
      input: z.strictObject({
        idempotencyKey,
        title: z.string().min(10).max(120),
        slug: z
          .string()
          .regex(SLUG)
          .max(80)
          .optional()
          .describe("lowercase-hyphenated; derived from the title if omitted"),
        description: z
          .string()
          .min(1)
          .max(200000)
          .describe("Full article as HTML"),
        ...optionalShape(contentFields),
        modelUsed: z.string().max(100).optional(),
      }),
      output: envelope(
        { blog: blogSummary, warnings: z.array(z.string()) },
        true,
      ),
      annotations: WRITE,
    },
    (args, ctx) => blogTools.createBlog(args, ctx),
  );
  register(
    "aquakart_update_blog",
    {
      title: "Update blog draft",
      description:
        "Edit fields of an existing DRAFT. Omitted fields stay unchanged; images are never changed here (use aquakart_attach_image). Published blogs cannot be edited.",
      scopes: [MCP_SCOPES.write],
      input: z.strictObject({
        idempotencyKey,
        blogId: objectId,
        expectedRevision,
        title: z.string().min(10).max(120).optional(),
        slug: z.string().regex(SLUG).max(80).optional(),
        description: z.string().min(1).max(200000).optional(),
        ...Object.fromEntries(
          Object.entries(contentFields).map(([key, schema]) => [
            key,
            (schema.nullable ? schema.nullable() : schema).optional(),
          ]),
        ),
      }),
      output: envelope({ blog: blogSummary }, true),
      annotations: WRITE,
    },
    (args, ctx) => blogTools.updateBlog(args, ctx),
  );
  register(
    "aquakart_upload_image",
    {
      title: "Upload blog image",
      description:
        "Upload a JPEG/PNG/WebP image (verified from its bytes, max 5 MB) to Aquakart's blog image storage. Identical images are de-duplicated. Returns a mediaId for aquakart_attach_image.",
      scopes: [MCP_SCOPES.upload],
      input: imageInput(),
      output: envelope(
        {
          media: z.object({
            mediaId: z.string(),
            publicId: z.string(),
            secure_url: z.string(),
            format: z.string().nullable().optional(),
            bytes: z.number().nullable().optional(),
            width: z.number().nullable(),
            height: z.number().nullable(),
          }),
          deduplicated: z.boolean(),
        },
        true,
      ),
      annotations: WRITE,
      meta: { "openai/fileParams": ["image"] },
    },
    (args, ctx) => blogTools.uploadImage(args, ctx),
  );
  register(
    "aquakart_attach_image",
    {
      title: "Attach title image",
      description:
        "Set an uploaded image (mediaId) as a blog's title image, replacing the previous one. applyBrandLogo overlays the stored official Aquakart logo (never AI-drawn). Live blogs also need blogs:publish.",
      scopes: [MCP_SCOPES.write],
      input: z.strictObject({
        idempotencyKey,
        blogId: objectId,
        mediaId: objectId,
        applyBrandLogo: z.boolean().optional(),
        expectedRevision,
      }),
      output: envelope({ blog: blogSummary, titleImage: media }, true),
      annotations: WRITE,
    },
    (args, ctx) => blogTools.attachImage(args, ctx),
  );
  register(
    "aquakart_publish_blog",
    {
      title: "Publish blog",
      description:
        "Publish a reviewed DRAFT to the live Aquakart website after quality checks (word count, meta description, title image, unique slug). Repeating it on a published blog changes nothing.",
      scopes: [MCP_SCOPES.publish],
      input: z.strictObject({
        idempotencyKey,
        blogId: objectId,
        expectedRevision,
      }),
      output: envelope(
        {
          blog: blogSummary,
          alreadyPublished: z.boolean(),
          publicUrl: z.string(),
          visibleOnStorefront: z.boolean(),
        },
        true,
      ),
      annotations: { ...WRITE, openWorldHint: true },
    },
    (args, ctx) => blogTools.publishBlog(args, ctx),
  );

  // ---- Instagram -----------------------------------------------------
  register(
    "aquakart_upload_instagram_image",
    {
      title: "Upload Instagram creative",
      description:
        "Upload a creative (JPEG/PNG/WebP, max 8 MB, at least 320 px wide, aspect 4:5 to 1.91:1) to temporary storage (aquakart/instagram-temp/). It is deleted automatically after verified publication. Returns an assetId.",
      scopes: [MCP_SCOPES.igUpload],
      input: imageInput(),
      output: envelope({ asset: igAsset, deduplicated: z.boolean() }, true),
      annotations: WRITE,
      meta: { "openai/fileParams": ["image"] },
    },
    (args, ctx) => instagramTools.uploadInstagramImage(args, ctx),
  );
  register(
    "aquakart_publish_instagram",
    {
      title: "Publish to Instagram",
      description:
        "Post an uploaded creative with a caption to the Aquakart Instagram account via Meta's official API, then verify it. Never posts the same asset twice; if the outcome is uncertain it reconciles with Meta instead of re-posting. Returns the media id and permalink.",
      scopes: [MCP_SCOPES.igPublish],
      input: z.strictObject({
        idempotencyKey,
        assetId: z.string().regex(/^iga_[0-9a-f-]{36}$/),
        caption: z.string().min(1).max(2200),
        altText: z.string().max(1000).optional(),
      }),
      output: envelope({ asset: igAsset, alreadyPublished: z.boolean() }, true),
      annotations: { ...WRITE, openWorldHint: true },
    },
    (args, ctx) => instagramTools.publishInstagram(args, ctx),
  );
  register(
    "aquakart_get_instagram_status",
    {
      title: "Get Instagram status",
      description:
        "Current lifecycle status of an Instagram asset: publication, media id, permalink and temporary-image cleanup.",
      scopes: [MCP_SCOPES.igRead],
      input: z.strictObject({
        assetId: z.string().regex(/^iga_[0-9a-f-]{36}$/),
      }),
      output: envelope({ asset: igAsset }),
      annotations: READ,
    },
    (args) => instagramTools.getInstagramStatus(args),
  );
  register(
    "aquakart_list_instagram_posts",
    {
      title: "List Instagram posts",
      description:
        "Recorded Instagram uploads and posts, newest first, optionally filtered by status.",
      scopes: [MCP_SCOPES.igRead],
      input: z.strictObject({
        status: z
          .enum([
            "UPLOADED",
            "CONTAINER_CREATED",
            "PROCESSING",
            "READY",
            "PUBLISHING",
            "PUBLISH_UNCERTAIN",
            "PUBLISHED_VERIFIED",
            "CLEANUP_PENDING",
            "CLEANED",
            "FAILED",
          ])
          .optional(),
        page: z.number().int().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      output: envelope({
        assets: z.array(igAsset),
        page: z.number(),
        limit: z.number(),
        total: z.number(),
      }),
      annotations: READ,
    },
    (args) => instagramTools.listInstagramPosts(args),
  );
  register(
    "aquakart_cleanup_instagram_asset",
    {
      title: "Delete temporary Instagram image",
      description:
        "Delete an asset's temporary image now. Allowed only after verified publication or for an upload that was never sent to Instagram; uncertain or in-flight posts are refused. Only touches aquakart/instagram-temp/.",
      scopes: [MCP_SCOPES.igCleanup],
      input: z.strictObject({
        idempotencyKey,
        assetId: z.string().regex(/^iga_[0-9a-f-]{36}$/),
      }),
      output: envelope(
        { asset: igAsset, cleaned: z.boolean(), alreadyCleaned: z.boolean() },
        true,
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    (args, ctx) => instagramTools.cleanupInstagramAsset(args, ctx),
  );

  return server;
};
