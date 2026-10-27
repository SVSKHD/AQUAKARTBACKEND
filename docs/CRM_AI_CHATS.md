# CRM AI conversations

Last updated: 2026-10-25 (Asia/Calcutta).

General CRM AI conversations are stored in `AquaCrmAiChat`, owned by the
authenticated staff account. All endpoints below require
`Authorization: Bearer <staff JWT>` through `authenticateStaff`. Disabled staff
are rejected. Even administrators cannot read another staff account's chats
through these endpoints. These APIs do not use customer quotas.

## Endpoints

Base path: `/v1/crm/ai`.

| Method | Path               | Purpose                                                                     |
| ------ | ------------------ | --------------------------------------------------------------------------- |
| POST   | `/chats`           | Create an empty conversation; optional `{ "title": "Customer follow-ups" }` |
| GET    | `/chats`           | List your conversation summaries, pinned first                              |
| GET    | `/chats/:id`       | Load a conversation with its retained messages                              |
| PATCH  | `/chats/:id`       | Rename, pin/unpin, archive/restore                                          |
| DELETE | `/chats/:id`       | Permanently delete the conversation and messages                            |
| POST   | `/generate`        | Generate and save a completed user/model turn                               |
| POST   | `/generate/stream` | Stream a reply, then save the completed turn                                |

List parameters: `page` (default 1, maximum 1,000,000), `limit` (default 20,
maximum 50), `q` (literal case-insensitive title search, maximum 120 characters),
`pinned=true|false` (optional), and `archived=true|false` (default false).
`archived=true` returns archived chats only. Ordering is `pinned`,
`lastMessageAt`, `_id`, all descending. The list omits messages and returns:

```json
{
  "success": true,
  "data": [],
  "pagination": { "page": 1, "limit": 20, "total": 0, "pages": 0 }
}
```

Create returns HTTP 201 with `{ success: true, data: <chat> }`. Read returns
the same envelope with HTTP 200. Patch returns metadata without messages:

```json
{ "title": "Installation questions", "pinned": true, "archived": false }
```

Send at least one recognized patch field. Titles must be nonblank and at most
120 characters after whitespace normalization. Flags must be JSON booleans;
omitted values remain unchanged. Pinning sets `pinnedAt`; unpinning clears it.
Archiving hides a chat from the default list and blocks further generation
until restored. Archived chats can still be read, renamed, pinned, or deleted.
Delete returns `{ "success": true, "data": { "deleted": true } }`.

## Generate and resume

For a new chat, omit `sessionId`:

```json
{
  "prompt": "Draft a follow-up for a water softener enquiry",
  "thinking": "medium"
}
```

Successful generation now includes `data.sessionId` alongside the existing
`reply`, `model`, `finishReason`, `usage`, and optional `thoughts`. Save that ID
in the client, refresh the chat list, and include it on subsequent requests:

```json
{ "sessionId": "6710a1b2c3d4e5f6a7b8c9d0", "prompt": "Make it shorter" }
```

Alternatively, create an empty chat first and pass its `_id` as `sessionId`.
The request uses `prompt`, as the existing generation endpoints do.
It does not use the invoice assistant's `message` field.

For existing chats the server loads the last 30 retained messages and ignores
client-supplied `history`. For a new chat only, the existing `history` option
can import up to its last 30 entries; entries are capped at 20,000 characters.
Imported entries count toward `messageCount` and seed the automatic title from
the first user message. Without imported history, the first prompt becomes the
title. Explicitly created chats retain their chosen title (or `New chat`).

The existing generation controls still work: prompts up to 20,000 characters,
`systemInstruction`, `temperature`, `json`, and `thinking` (true, medium, high,
or off). Custom settings are not stored and must be resent on each request.
Thought summaries are returned to the caller but are not persisted as messages.

Streaming uses POST SSE events: `thought`, `delta`, `done`, `error`.
`done` includes `sessionId` only after the completed turn is saved. Before SSE
headers are sent, errors use normal JSON/HTTP statuses. Afterwards, failures use
`error {status,message}` on the already-open HTTP 200 stream. Clients must wait
for `done` before marking a turn as saved; a partial stream is not a saved turn.

## Retention, consistency, and errors

- Each conversation retains its latest 200 messages, including user and model
  messages. `messageCount` counts all appended/imported messages even after older
  entries are trimmed. There is no automatic expiry or full-history export.
- Successful turns append atomically. A failed provider call adds no messages;
  a failed new-chat generation creates no conversation. Empty chats created
  explicitly remain available after failed generation.
- Concurrent requests may both invoke the AI, but only the first append based
  on a given message count succeeds. The other receives 409 and must reload.
  Deletion or archiving during generation also prevents appending. A generated
  reply can therefore be discarded on conflict; clients should serialize sends.
- 400: malformed chat ID, invalid title/flags/pagination, or invalid prompt.
  404: missing chat or a chat owned by someone else. 409: archived or stale chat.
  401: failed staff authentication. Provider errors can return 429/502/503;
  storage failures return 500. Errors use `{ success: false, message }` before SSE.
- Existing stateless requests still accept the same fields, but successful
  general CRM generations now create saved conversations automatically.
  Conversations from before this change cannot be recovered server-side unless
  the client still has and submits their history.
- Invoice draft sessions under `/invoice/sessions` and customer storefront
  transcripts remain separate models and flows. No automatic migration merges them.

## Implementation and checks

- Router: `src/routes/crm/ai.js` (mounted in `app.js`).
- CRUD: `src/controllers/crm/aiChats.js`; persistence/context:
  `src/services/crm/aiChats.js`; model: `src/models/crm/aiChat.js`.
- Generation integration: `src/controllers/ai.js`.
- Swagger contracts: `src/docs/crmAi.js`, applied at generation and UI loading;
  all operations are grouped as `CRM / AI`.
- Checks: `node --test test/crmAiChats.test.js test/aiChatUpdate.test.js test/gemini.test.js test/aiInvoiceDraft.test.js test/routeGroups.test.js`
  and `npm run swagger`.

The backend API is ready for a CRM conversation sidebar; this change does not
edit the separate CRM frontend repository.
