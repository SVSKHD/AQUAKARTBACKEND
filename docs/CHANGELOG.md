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
