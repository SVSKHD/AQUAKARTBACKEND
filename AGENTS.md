# Backend agent instructions

Applies to this repository and all descendants unless a more specific AGENTS.md
adds local guidance. Last reviewed: 2026-10-25 (Asia/Calcutta).

## Start with focused context

1. Read this file, [docs/README.md](docs/README.md), and the relevant section of
   [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md).
2. Read the newest relevant entry in [docs/CHANGELOG.md](docs/CHANGELOG.md) and
   the linked domain guide. Do not read every guide for every task.
3. Check `git status --short` before editing; preserve unrelated user changes.
4. Open the relevant route, its controller, and the models/services it calls.
   Use `app.js` only when mounting, middleware order, or route prefixes matter.

Do not scan the whole project by default. Start with scoped `rg`/`rg --files`
queries in the mapped module and expand only when imports, callers, failures,
or missing context justify it. Do not dump `swagger-output.json`, lockfiles,
`node_modules`, caches, or all tests to discover a small feature. Read targeted
sections instead. Documentation is a navigation aid; verify behavior in source.
If docs and source disagree, fix the relevant docs with the code change.

## Implementation rules

- This is an Express backend using ES modules, Mongoose, and Node's test runner.
  Start from the conventions of nearby code; do not introduce a framework.
- Keep route -> controller -> service/model responsibilities clear. Validate
  client input and preserve existing authentication and permission checks.
- For routes, follow their mounted prefix in `app.js`; a file existing under
  `src/routes` does not prove it is mounted. CRM and storefront contracts differ.
- Preserve supported aliases and partial-update behavior. Check populated
  references, omitted versus null fields, existing media, and error responses
  when modifying product/category updates.
- Do not execute requests that write production data, send notifications,
  charge payments, or run seed scripts merely to test a change.
- Do not read, print, copy into docs, or commit secret values. Use `.env.example`
  and configuration source to identify variable names. Credential JSON and
  `.env` files stay outside the Docker image and repository.
- Stay within this backend unless the task requires another repository. Sibling
  storefront/CRM projects are separate workspaces with their own instructions.

## Validation and Swagger

- Run focused checks first: `node --check <changed-file.js>` and relevant
  `node --test test/<module>.test.js` files. Run broader tests for shared changes
  or unresolved risk; record exactly what passed, failed, or was not run.
- Use `npm ci` with the committed `package-lock.json`. Update the lockfile when
  dependencies change. Keep ESLint compatible with the Airbnb config; do not
  bypass peer conflicts with `--force` or `--legacy-peer-deps` as a routine fix.
- After adding/changing an API contract, run `npm run swagger` and inspect the
  affected operations, auth, payloads, status codes, and response schemas.
  Folder/module grouping lives in `src/docs/routeGroups.js`; precise category
  contracts live in `src/docs/categories.js`. Maintain explicit contracts there
  rather than editing only generated JSON. Extend source docs for other domains
  when inference is insufficient.
- New routes must have a meaningful module/folder Swagger group. Follow the
  existing literal `router.METHOD(...)` and mounted router conventions; if using
  a different pattern, update discovery and its focused tests.
- On PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.
- Starting `index.js` connects MongoDB, starts scheduled jobs, and regenerates
  Swagger. Do not start it solely for a syntax or unit check.

## Required documentation after every LLM code change

Before completing a task that changes code, configuration, dependencies, tests,
or documentation:

1. Update the relevant domain guide if behavior, payloads, responses, environment
   setup, or operations changed. Update PROJECT_MAP when paths/modules change.
2. Append a new entry under today's date in `docs/CHANGELOG.md`, using
   `YYYY-MM-DD` in **Asia/Calcutta**. Put newest date sections first. Within a
   date, append entries without rewriting earlier history. Use a short distinct
   title for each task; add time only if known.
3. Record the problem, resulting behavior, exact affected file paths, validation
   commands/results, and any remaining limitation or follow-up. Distinguish
   static review, dry runs, unit tests, and live verification.
4. Log only work actually performed. Do not claim deployment, testing, or authorship
   of unrelated changes. Do not invent dates or backfill historical work from
   guesses. Read-only investigations need an entry only if they update docs.
5. If blocked, record completed changes and the concrete blocker; do not mark
   incomplete work as delivered. Keep the final user response consistent with
   the log and name any unverified behavior.

These updates are part of the same task as the implementation, not optional
future work. The rule is an agent workflow requirement, not an automatic watcher.
