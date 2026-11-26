export const PERMISSIONS = Object.freeze([
  "roles.read",
  "roles.manage",
  "staff.read",
  "staff.manage",
  "customers.read",
  "ai.chats.read",
  "blogs.manage",
  "instagram.publish",
  // Social post drafts: read, create/edit (incl. via MCP), approve/reject
  // in the CRM. Publishing an approved post also needs instagram.publish.
  "social.read",
  "social.manage",
  "social.review",
  "products.read",
  "products.manage",
  "coupons.read",
  "coupons.manage",
  "referrals.read",
  "referrals.manage",
  "rewards.read",
  "rewards.manage",
  "orders.read",
  "orders.manage",
  "invoices.read",
  "invoices.manage",
  // MCP invoice data-quality audit (aquakart_audit_invoices etc.) and
  // executing approved suggestions. Assigned to no role by default.
  "invoices.audit",
  "invoices.audit.execute",
  "payments.read",
  "payments.create",
  "payments.reconcile",
  "payments.refund",
  // Admin-created offline payment links (pre-invoices and quotations).
  "payments.link.manage",
  "preinvoices.read",
  "preinvoices.manage",
  "gateways.read",
  "gateways.manage",
  "seo.read",
  "seo.manage",
  "analytics.read",
  "audit.read",
  "jobs.read",
  "jobs.manage",
  "settings.read",
  "settings.manage",
  // Transit (docs/TRANSIT.md). A transporter role gets transit.operate only:
  // its own submissions, collections and payout status. transit.read sees
  // every transporter's records and reports; transit.manage edits pricing,
  // warehouse, benchmarks, verifies collections and records corrections;
  // transit.settle pays transporters (never their own payouts).
  "transit.operate",
  "transit.read",
  "transit.manage",
  "transit.settle",
]);

export const SUPER_ADMIN_ROLE = "super-admin";

export const isKnownPermission = (permission) =>
  PERMISSIONS.includes(permission);
