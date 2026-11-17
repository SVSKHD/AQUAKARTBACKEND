export const PERMISSIONS = Object.freeze([
  "roles.read",
  "roles.manage",
  "staff.read",
  "staff.manage",
  "customers.read",
  "ai.chats.read",
  "blogs.manage",
  "instagram.publish",
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
]);

export const SUPER_ADMIN_ROLE = "super-admin";

export const isKnownPermission = (permission) =>
  PERMISSIONS.includes(permission);
