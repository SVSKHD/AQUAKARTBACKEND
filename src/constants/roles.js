// Storefront account roles. Each account points at a role document in the
// `aquauserroles` collection (AquaEcomUser.roleRef); an account without one is
// a plain "user", the default. The numeric AquaEcomUser.role is kept in step
// for older code that still reads it.
//
//   slug     legacy role  unlimited AI chats
//   admin    1            yes (CRM super-admins are also stored as 1)
//   user     2            no  (the default for every account)
//   tester   4            yes (QA accounts, on production and development)
//
// Role 3 (CRM staff) lives on CRM staff accounts, not here.
export const USER_ROLES = Object.freeze({
  ADMIN: 1,
  USER: 2,
  STAFF: 3,
  TESTER: 4,
});

export const DEFAULT_USER_ROLE = "user";

// The system roles every environment has (created on start-up).
export const SYSTEM_USER_ROLES = Object.freeze([
  {
    slug: "admin",
    name: "Admin",
    description: "AquaKart administrators. No AI chat limit.",
    legacyRole: USER_ROLES.ADMIN,
    unlimitedAi: true,
  },
  {
    slug: "tester",
    name: "Tester",
    description:
      "QA accounts for testing production and development. No AI chat limit.",
    legacyRole: USER_ROLES.TESTER,
    unlimitedAi: true,
  },
  {
    slug: DEFAULT_USER_ROLE,
    name: "User",
    description:
      "Every storefront customer (the default). Daily AI chat limit.",
    legacyRole: USER_ROLES.USER,
    unlimitedAi: false,
    isDefault: true,
  },
]);

const LEGACY_SLUG = Object.freeze({
  [USER_ROLES.ADMIN]: "admin",
  [USER_ROLES.USER]: DEFAULT_USER_ROLE,
  [USER_ROLES.STAFF]: "staff",
  [USER_ROLES.TESTER]: "tester",
});
const LEGACY_UNLIMITED = Object.freeze([USER_ROLES.ADMIN, USER_ROLES.TESTER]);

// A populated role document (not just its id).
const roleDoc = (user) => {
  const ref = user?.roleRef;
  return ref && typeof ref === "object" && typeof ref.slug === "string"
    ? ref
    : null;
};

// The account's role slug: its role document's, else the legacy number's,
// else the default.
export const userRoleSlug = (user) =>
  roleDoc(user)?.slug ||
  LEGACY_SLUG[Number(user?.role)] ||
  (user ? DEFAULT_USER_ROLE : null);

// "admin" | "tester" (the slug) for an account with unlimited AI chats, else
// null. The role document decides (an inactive role grants nothing); accounts
// not yet linked to one fall back to the legacy number.
export const unlimitedAiRole = (user) => {
  const doc = roleDoc(user);
  if (doc) return doc.isActive !== false && doc.unlimitedAi ? doc.slug : null;
  const role = Number(user?.role);
  return LEGACY_UNLIMITED.includes(role) ? LEGACY_SLUG[role] : null;
};
