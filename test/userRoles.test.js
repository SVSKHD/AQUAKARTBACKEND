import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_USER_ROLE,
  SYSTEM_USER_ROLES,
  unlimitedAiRole,
  userRoleSlug,
} from "../src/constants/roles.js";
import UserRole from "../src/models/userRole.js";
import { quotaSubject } from "../src/services/aiQuota.js";

const role = (slug, extra = {}) => ({
  _id: `r-${slug}`,
  ...SYSTEM_USER_ROLES.find((r) => r.slug === slug),
  isActive: true,
  ...extra,
});

test("the system roles are admin, tester and user, with user the default", () => {
  assert.deepEqual(
    SYSTEM_USER_ROLES.map((r) => [r.slug, r.unlimitedAi, r.legacyRole]),
    [
      ["admin", true, 1],
      ["tester", true, 4],
      ["user", false, 2],
    ],
  );
  assert.equal(SYSTEM_USER_ROLES.filter((r) => r.isDefault).length, 1);
  assert.equal(DEFAULT_USER_ROLE, "user");
});

test("an account's role comes from its role document", () => {
  const tester = { _id: "u1", role: 2, roleRef: role("tester") };
  assert.equal(userRoleSlug(tester), "tester");
  assert.equal(unlimitedAiRole(tester), "tester");
  assert.equal(quotaSubject({ user: tester, ip: "1.1.1.1" }).role, "tester");

  const user = { _id: "u2", role: 2, roleRef: role("user") };
  assert.equal(userRoleSlug(user), "user");
  assert.equal(unlimitedAiRole(user), null);

  // Switching a role off in the database takes its unlimited chats away.
  const off = { _id: "u3", roleRef: role("admin", { isActive: false }) };
  assert.equal(unlimitedAiRole(off), null);
});

test("accounts not linked to a role fall back to the legacy number, then user", () => {
  assert.equal(userRoleSlug({ _id: "a", role: 1 }), "admin");
  assert.equal(unlimitedAiRole({ _id: "a", role: 1 }), "admin");
  assert.equal(unlimitedAiRole({ _id: "t", role: 4 }), "tester");
  assert.equal(unlimitedAiRole({ _id: "s", role: 3 }), null);
  assert.equal(userRoleSlug({ _id: "n" }), "user");
  // An unpopulated id says nothing on its own: the number decides.
  assert.equal(unlimitedAiRole({ _id: "x", role: 2, roleRef: "64ab" }), null);
  assert.equal(userRoleSlug(null), null);
});

test("ensureDefaults creates missing system roles without overwriting edits", async () => {
  const calls = [];
  const fakeModel = {
    updateOne: async (filter, update, options) => {
      calls.push({ filter, update, options });
    },
    find: () => ({
      sort: () => ({
        lean: async () => SYSTEM_USER_ROLES.map((r) => ({ ...r })),
      }),
    }),
  };
  const roles = await UserRole.ensureDefaults.call(fakeModel);
  assert.deepEqual(
    calls.map((c) => c.filter.slug),
    ["admin", "tester", "user"],
  );
  for (const c of calls) {
    assert.equal(c.options.upsert, true);
    // Only on insert: an existing role is never changed.
    assert.deepEqual(Object.keys(c.update), ["$setOnInsert"]);
    assert.equal(c.update.$setOnInsert.isSystem, true);
  }
  assert.equal(roles.length, 3);
});
