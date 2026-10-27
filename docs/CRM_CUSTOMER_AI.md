# CRM customer users, AI questions, and blog drafts

Updated: 2026-10-26 (Asia/Calcutta).

This CRM workflow reviews **customer storefront conversations**, separately from
the staff-private chats described in [CRM_AI_CHATS.md](CRM_AI_CHATS.md). It uses
the existing customer account and saved chat models; it does not create duplicate
users or change account credentials.

## Access and user management

All endpoints below require a staff JWT in `Authorization: Bearer <token>`.
Review requires both `customers.read` and `ai.chats.read`. Generating or listing
source-linked blogs additionally requires `blogs.manage`. Active super-admins and
legacy numeric role-1 administrators have access through existing RBAC behavior.
Other staff must be granted the new permissions through CRM role/direct-permission
management. Disabled staff fail authentication. Customer JWTs are not accepted.

The directory uses an explicit profile allowlist: `_id`, first/last names, email,
phone, photoURL, createdAt, lastLoginAt, loginCount, emailVerified. Passwords,
OTPs, Firebase IDs, social provider payloads, addresses, cart and order details
are not part of these responses. The selected user ID is the same ID used by the
existing `/v1/crm/customers/:id` user management endpoints. Existing customer
create/update/delete permissions and behavior are unchanged; those administrator
APIs remain the profile-editing workflow.

## CRM screen flow

1. Search/list users via `GET /v1/crm/ai/users?q=<name, email or phone>`.
   Each result includes `ai: { chats, messages, lastMessageAt }`. Users with no
   saved chats have zero counts. `messages` is the cumulative message count,
   including older messages removed by retention.
2. Load one profile with `GET /v1/crm/ai/users/:userId` and its conversations with
   `GET /v1/crm/ai/users/:userId/chats`.
3. Read the transcript with
   `GET /v1/crm/ai/users/:userId/chats/:chatId`. It contains `messages` plus
   `qa: [{ questionId, answerId, question, answer, askedAt, answeredAt }]`.
   Only complete user/model exchanges are paired; unanswered messages still
   appear in the raw transcript. All lookups check that the chat belongs to the
   user in the URL.
4. Present the answered questions as selectable rows. Generate an editable blog
   from the selected question IDs using the POST below. Disable repeated clicks
   while generating; each POST intentionally creates a separate draft.
5. Open the returned blog in the existing CRM blog editor. Add images, check facts,
   review personal details and publish explicitly. No chat action auto-publishes.
6. Reload the source-linked article list to show drafts or articles already
   published by editors.

List endpoints support `page` (default 1, maximum 1,000,000) and `limit` (default
20, maximum 50), returning `{ success: true, data: [], pagination: { page, limit,
total, pages } }`. User search is literal/case-insensitive for name/email and
exact numeric matching for 6–15 digit phone numbers. `q` is limited to 120
characters. User ordering is newest created first; chats use latest activity
first. Single-item reads return `{ success: true, data: ... }`.

## Generate a blog

`POST /v1/crm/ai/users/:userId/chats/:chatId/blog-drafts`

```json
{
  "questionIds": ["6710a1b2c3d4e5f6a7b8c9d2"],
  "instructions": "Turn these questions into a practical hard-water troubleshooting guide"
}
```

`questionIds` is optional. If provided, it must contain 1–20 distinct user-message
IDs with answers in this chat. IDs of answers, other users' chats, unanswered or
trimmed questions are rejected. Without it, the latest 20 complete exchanges
are used. `instructions` is optional, with a maximum of 2,000 characters. Send
`{}` to use the defaults. Each selected question is limited to 2,000 characters
and its answer to 3,000 characters in the generation source.

The backend reuses the existing SEO blog prompt, taxonomy validation and article
normalization. It reads bounded category/product context, removes known account
names and common email/phone/link/reference patterns from source text, treats chat
content as untrusted topic material, and instructs the AI to generalize and check
claims. It applies redaction again to generated text and restricts article HTML
to editorial tags without attributes. This does **not** guarantee that every
possible personal detail or incorrect AI claim is detected; editorial review is
required before publishing. No full user profile is sent to the AI.

Success is HTTP 201:

```json
{
  "success": true,
  "data": {
    "blog": {
      "_id": "6710a1b2c3d4e5f6a7b8c9d4",
      "title": "Checking Water Hardness at Home",
      "status": "draft",
      "generatedBy": "ai"
    },
    "source": {
      "chatId": "6710a1b2c3d4e5f6a7b8c9d1",
      "questionIds": ["6710a1b2c3d4e5f6a7b8c9d2"]
    },
    "model": "configured-blog-model"
  }
}
```

The real blog object also contains its editable HTML and normalized SEO fields.
The stored `sourceAiChat`, `sourceAiQuestions` and `sourceAiRequestedBy` fields
track provenance and are excluded from normal blog queries (`select: false`).
They may appear in the privileged creation response. An audit entry records
the staff actor, blog ID and source message IDs, without copying the transcript.

`GET /v1/crm/ai/users/:userId/chats/:chatId/blog-drafts` returns paginated article
metadata for that source chat, including articles subsequently published. The
existing administrator list `GET /v1/all-blogs?status=draft` also lists drafts.
For an individual draft use `GET /v1/blog/:id?status=draft` (or `status=all`) with
an administrator token. Public blog-by-ID, title, slug and list queries exclude
drafts. Existing blog update/media/publish endpoints remain in `src/routes/blog.js`.
Delegated `blogs.manage` access to generation does not change those legacy
administrator-only publishing endpoints.

## Limits and errors

Only logged-in customer conversations already saved by the storefront can be
reviewed. Guest chats and messages trimmed beyond the latest 200 cannot be
recovered. Staff CRM/invoice chats are not silently mixed into this view. There
is no new transcript-edit/delete API in this editorial workflow.

400 means invalid parameters, selection, or no answered questions; 401 means
invalid staff authentication; 403 means missing permissions; 404 means missing
user or mismatched chat. Invalid/too-short AI output returns 502 and creates no
blog; provider failures can return 429/502/503. Unexpected storage failures return 500. Errors use `{ success: false, message }`. A saved draft is not automatically
removed if its source chat is later deleted; hidden provenance IDs remain for
editorial history.

## Source and checks

- Routing/access: `src/routes/crm/ai.js`, `src/constants/permissions.js`.
- User directory and transcript endpoints: `src/controllers/crm/aiUsers.js`.
- Q/A selection, redaction, HTML restriction and generation:
  `src/services/crm/customerAi.js`.
- Provenance: `src/models/blog.js`; public draft filtering:
  `src/controllers/blog.js`, `src/routes/blog.js`.
- Swagger: `src/docs/crmCustomerAi.js`, applied during generation and UI loading.
- Tests: `test/crmCustomerAi.test.js`, `test/crmCustomerAiDocs.test.js`, plus existing
  AI blog generation and CRM chat suites.

This task adds the CRM-facing backend API. The separate `AQUACRM25DEV` frontend
still needs its directory, chat review and “Create blog” actions wired to it.
