# Social post drafts (Instagram / Facebook)

Unpublished social posts created over MCP, reviewed by staff in AQUACRM and
published as a separate action after approval. The blog workflow is
unchanged.

Daily flow:

1. **08:00 IST:** ChatGPT writes the day's poster, caption and metadata into
   the Aquakart Google Drive folder.
2. **08:30 IST:** Claude Code calls `aquakart_create_social_draft` with the
   Drive file ids (or uploads a poster with `aquakart_create_image_upload` and
   passes its `mediaId`), then reads the draft back with
   `aquakart_get_social_draft`.
3. **AQUACRM:** staff review drafts at `/v1/crm/social-posts`, edit, approve
   or reject.
4. **Publishing:** a separate, explicit action on an approved post (CRM
   `POST /v1/crm/social-posts/:id/publish` or the MCP tool
   `aquakart_publish_social_post`). Nothing posts automatically.

## Data model: `AquaSocialPost`

`src/models/socialPost.js`.

| Field                  | Meaning                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `platforms`            | `instagram` and/or `facebook` (at least one)                                                                                               |
| `title`                | Internal title for reviewers (3-150)                                                                                                       |
| `caption`              | Plain text. Instagram rules when Instagram is a target (2,200 chars, 30 hashtags, 20 mentions); otherwise max 5,000                        |
| `altText`, `notes`     | Accessible description; reviewer note (never posted)                                                                                       |
| `scheduledFor`         | Preferred posting time from the content plan; informational                                                                                |
| `status`               | `draft`, `approved`, `rejected`, `publishing`, `published`                                                                                 |
| `media`                | Snapshot of the poster: `mediaId` (`AquaMcpMedia`), `publicId`, `imageUrl`, size, `sha256`                                                 |
| `source`               | `google_drive` (`folderId`, `imageFileId`/`imageVersion`, `captionFileId`/`captionVersion`, `metadataFileId`/`metadataVersion`) or `media` |
| `contentKey`           | Unique: SHA-256 of poster bytes + caption + platforms, so the same post is drafted once                                                    |
| `review`               | `decision`, `by` (staff id), `at`, `note`                                                                                                  |
| `publishing.instagram` | `status` (`pending`, `published`, `failed`), `assetId` (`AquaInstagramAsset`), `externalId`, `permalink`, `publishedAt`, `lastError`       |
| `publishing.facebook`  | `{ status: "unsupported" }` when Facebook was a target                                                                                     |
| `integration`          | MCP client, staff member and operation ids                                                                                                 |
| `history`              | Last 40 status changes with who and why                                                                                                    |

Revision (`revision` in responses) is `updatedAt`; edits, reviews and
publishes accept `expectedRevision` and fail with `REVISION_CONFLICT` when
the post changed.

### Lifecycle

```
draft --approve(CRM)--> approved --publish--> publishing --> published
draft --reject(CRM, reason)--> rejected --edit--> draft
approved --reject(CRM)--> rejected
approved --edit(CRM)--> draft            (needs approval again)
publishing --failure--> approved         (publishing.instagram.lastError set)
```

### Where the poster lives

The poster is stored once in Aquakart's Cloudinary through the existing MCP
media store (`Blogs/mcp_<sha>`, `AquaMcpMedia`, de-duplicated by SHA-256) and
**stays there** while the post waits for review and after it is published.
At publish time the existing Instagram tools make their own temporary copy
(`aquakart/instagram-temp/`) for Meta; the Instagram cleanup worker deletes
only that copy after Meta confirms the post. A poster used by a social post
is never deleted when a blog banner that shares it is replaced.

## MCP tools

| Tool                           | Scopes                          | Notes                                                                                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aquakart_create_social_draft` | `social:write` + `media:upload` | `mediaId` **or** `source { type: "google_drive", imageFileId, captionFileId?, metadataFileId?, folderId? }`; `platforms` (default `["instagram"]`), `title`, `caption`, `altText`, `notes`, `scheduledFor`, `idempotencyKey?`. Returns `post`, `alreadyExists`, `deduplicatedImage` |
| `aquakart_update_social_draft` | `social:write`                  | `idempotencyKey`, `postId`, `expectedRevision?`, any field or a new `mediaId`. Drafts and rejected posts only; a rejected post returns to draft                                                                                                                                     |
| `aquakart_get_social_draft`    | `social:read`                   | `post` with `checks { readyForReview, problems[], warnings[] }`                                                                                                                                                                                                                     |
| `aquakart_list_social_drafts`  | `social:read`                   | `status?`, `platform?`, `query?`, `page`, `limit≤50`                                                                                                                                                                                                                                |
| `aquakart_publish_social_post` | `instagram:publish`             | Approved posts only                                                                                                                                                                                                                                                                 |

There is **no MCP approve tool**: approval needs a person with
`social.review` in the CRM.

### Drive inputs

All files must be inside `GOOGLE_DRIVE_BANNER_FOLDER_IDS` (or a subfolder)
and shared with the Drive service account, exactly as for blog banners (see
[MCP_BLOG_PUBLISHING.md](MCP_BLOG_PUBLISHING.md#setting-up-drive-access)).

- **Image:** JPEG/PNG/WebP, checked from the bytes; at least 320x320, at
  most `MCP_BANNER_MAX_DIMENSION` px on a side, at most `MCP_IMAGE_MAX_BYTES`.
  If `folderId` is given, the image must be directly in that folder.
- **Caption (`captionFileId`):** `.txt`/`.md` or a Google Doc (exported as
  text), max 20 KB.
- **Metadata (`metadataFileId`):** JSON object; optional keys `title`,
  `platforms`, `caption`, `altText`, `notes`, `scheduledFor`.
- Precedence: explicit tool arguments, then the caption file (for the
  caption), then the metadata file.

Example metadata file:

```json
{
  "title": "White spots on taps and tiles?",
  "platforms": ["instagram", "facebook"],
  "altText": "Bathroom tap with white limescale spots",
  "scheduledFor": "2026-11-21T18:30:00+05:30"
}
```

### Checks

Instagram targets need an aspect ratio between 4:5 and 1.91:1 and a width of
at least 320px (`INVALID_ASPECT_RATIO` on create/edit). `checks.warnings`
flags missing alt text and that Facebook will not be posted.

### Idempotency

Without `idempotencyKey`, the server derives one from the poster (media id,
or Drive file id + version), caption hash and fields, so re-running the 08:30
import replays the stored result. A different key with the same poster,
caption and platforms returns the existing post with `alreadyExists: true`.

### Sample Claude Code calls

```json
{
  "name": "aquakart_create_social_draft",
  "arguments": {
    "source": {
      "type": "google_drive",
      "folderId": "1DayFolderIdXXXXXXXXXXXXXXXX",
      "imageFileId": "1PosterFileIdXXXXXXXXXXXXXXX",
      "captionFileId": "1CaptionFileIdXXXXXXXXXXXXXX",
      "metadataFileId": "1MetadataFileIdXXXXXXXXXXXXX"
    }
  }
}
```

```json
{
  "name": "aquakart_get_social_draft",
  "arguments": { "postId": "<post.postId from the create result>" }
}
```

Verify `post.status` is `draft`, `post.image.imageUrl` is set and
`post.checks.readyForReview` is `true`.

## CRM routes (`/v1/crm/social-posts`)

Staff JWT (`Authorization: Bearer <token>`). Responses are
`{ success: true, ... }` or `{ success: false, code, message, details? }`.

| Method and path     | Permission                            | Body / query                                                                                                                        |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`             | `social.read`                         | `status`, `platform`, `q`, `page`, `limit≤50` → `posts`, `total`                                                                    |
| `GET /:id`          | `social.read`                         | → `post`                                                                                                                            |
| `PATCH /:id`        | `social.manage`                       | `title`, `caption`, `altText`, `notes`, `platforms`, `scheduledFor`, `mediaId`, `expectedRevision`; approved posts go back to draft |
| `POST /:id/approve` | `social.review`                       | `note?`, `expectedRevision?`; refused (`SOCIAL_POST_NOT_READY`) while `checks.problems` is not empty                                |
| `POST /:id/reject`  | `social.review`                       | `note` (required), `expectedRevision?`                                                                                              |
| `POST /:id/publish` | `social.review` + `instagram.publish` | `expectedRevision?` → `post`, `alreadyPublished`                                                                                    |

HTTP status by error code: 404 `SOCIAL_POST_NOT_FOUND`, `MEDIA_NOT_FOUND`;
400 `VALIDATION_FAILED`; 422 `INVALID_CAPTION`, `INVALID_ASPECT_RATIO`,
`PLATFORM_NOT_SUPPORTED`; 409 `REVISION_CONFLICT`, `INVALID_STATUS`,
`SOCIAL_POST_NOT_EDITABLE`, `SOCIAL_POST_NOT_APPROVED`,
`SOCIAL_POST_NOT_READY`, `DUPLICATE_SOCIAL_POST`, `PUBLISH_IN_PROGRESS`,
`PUBLISH_UNCERTAIN`, `ALREADY_POSTED`; 503 `INSTAGRAM_NOT_CONFIGURED`; 502 for
Meta/Cloudinary/Drive failures.

## Publishing

`publishSocialPost` (shared by the CRM route and the MCP tool):

1. Refuses posts that are not `approved` (`SOCIAL_POST_NOT_APPROVED`) and
   Facebook-only posts (`PLATFORM_NOT_SUPPORTED`). A published post returns
   `alreadyPublished: true`.
2. Claims the post (`approved` → `publishing`, with a lock) so concurrent
   clicks publish once.
3. Reads the permanent poster from Aquakart's Cloudinary and hands it to the
   existing Instagram tools with idempotency keys derived from the post id,
   poster and caption: `aquakart_upload_instagram_image` logic (temporary
   copy, aspect check) then `aquakart_publish_instagram` logic (container,
   never-twice publish, Meta verification, delayed cleanup).
4. Success: `published`, with `publishing.instagram` (media id, permalink)
   and Facebook marked `unsupported`. Failure: back to `approved` with
   `publishing.instagram.lastError`; a retry reuses the same Instagram
   operations, so an uncertain earlier attempt is reconciled with Meta
   instead of posting twice.

## Permissions and scopes

- New CRM permissions: `social.read`, `social.manage`, `social.review`
  (assigned to no role by default; super-admins and legacy role 1 have all).
- New MCP scopes: `social:read` (needs `social.read`) and `social:write`
  (needs `social.manage`). Publishing uses the existing `instagram:publish`
  (`instagram.publish`).
- Existing connections must re-authorize to receive the new scopes.

## Configuration

No new variables. Uses the Drive settings (`GOOGLE_DRIVE_*`), the MCP image
limits (`MCP_IMAGE_MAX_BYTES`, `MCP_BANNER_MAX_DIMENSION`) and the Instagram
settings (`INSTAGRAM_*`).

## Logs and audit

- One JSON line per create (`mcp.social.create`) and publish
  (`social.publish`) with `correlationId`, client, post id, outcome code and
  duration; never tokens or captions.
- Audit actions: `mcp.social.create`, `mcp.social.update`,
  `crm.social.update`, `crm.social.approve`, `crm.social.reject`,
  `social.publish`, plus the existing `mcp.media.upload`,
  `mcp.instagram.upload` and `mcp.instagram.publish`.

## Known limitations

- Facebook posting is not implemented (no Page token or Graph Page calls).
  Facebook is stored as a target and reported as `unsupported`.
- Single-image posts only (no carousels, reels or stories), as for the
  existing Instagram tools.
- `scheduledFor` is informational; there is no automatic posting job.
- The AQUACRM front end has no screen for these routes yet.
- The same exact poster image can be posted to Instagram only once
  (existing Instagram rule, `ALREADY_POSTED`).
- Posters are stored under the existing `Blogs/mcp_<sha>` Cloudinary prefix
  shared with blog images.
