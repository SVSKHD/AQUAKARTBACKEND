export const PERMISSIONS = Object.freeze([
  "roles.read",
  "roles.manage",
  "staff.read",
  "staff.manage",
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
  "payments.read",
  "payments.create",
  "payments.reconcile",
  "payments.refund",
  "gateways.read",
  "gateways.manage",
  "seo.read",
  "seo.manage",
  "audit.read",
]);

export const SUPER_ADMIN_ROLE = "super-admin";

export const isKnownPermission = (permission) =>
  PERMISSIONS.includes(permission);
