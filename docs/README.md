# Backend documentation index

Last reviewed: 2026-10-26 (Asia/Calcutta).

Agents start with [../AGENTS.md](../AGENTS.md), then use the
[project map](PROJECT_MAP.md) to choose source files and guides.
[CHANGELOG.md](CHANGELOG.md) records dated changes and verification, newest date
first. Read only the sections relevant to the task.

| Task                                                            | Read next                                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Find code, route prefixes, startup behavior, commands           | [PROJECT_MAP.md](PROJECT_MAP.md)                                                          |
| Understand recent changes or add a completed task record        | [CHANGELOG.md](CHANGELOG.md)                                                              |
| Google/Firebase authentication                                  | [AUTH_GOOGLE_FIREBASE.md](AUTH_GOOGLE_FIREBASE.md)                                        |
| Checkout, payments, coupons, referrals                          | [COMMERCE_PLATFORM_API.md](COMMERCE_PLATFORM_API.md)                                      |
| Invoice reporting/export                                        | [INVOICE_REPORTS.md](INVOICE_REPORTS.md)                                                  |
| Product maintenance reminders                                   | [PRODUCT_SERVICE_REMINDERS.md](PRODUCT_SERVICE_REMINDERS.md)                              |
| Fast2SMS/WhatsApp configuration                                 | [FAST2SMS_WHATSAPP.md](FAST2SMS_WHATSAPP.md)                                              |
| CRM AI chat history, pinning, archive, generation and streaming | [CRM_AI_CHATS.md](CRM_AI_CHATS.md)                                                        |
| CRM customer users, their AI questions/answers, and blog drafts | [CRM_CUSTOMER_AI.md](CRM_CUSTOMER_AI.md)                                                  |
| Products, category contracts, Swagger, CRM, AI, scheduling      | Start with the relevant row in [PROJECT_MAP.md](PROJECT_MAP.md); verify details in source |

`docs/` contains human/agent guides. `src/docs/` contains executable Swagger
customization. `swagger-output.json` is generated output served at
`/v1/api-docs`; it is not the starting point for project discovery.

When adding a guide, link it here and from its PROJECT_MAP row. Keep current
behavior in domain guides and the project map; keep dated task history in the
changelog. Avoid duplicating full API contracts across several documents.
