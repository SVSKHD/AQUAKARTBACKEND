import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  hashSessionToken,
  isSessionRevoked,
  revokeSession,
} from "../src/services/auth/sessionRevocation.js";
import { logout } from "../src/controllers/googleAuth.js";

process.env.JWT_SECRET ||= "session-revocation-test-secret";

const memory = () => {
  const rows = new Map();
  return {
    rows,
    connected: () => true,
    findOne: async ({ tokenHash }) => rows.get(tokenHash) || null,
    upsert: async (doc) => {
      if (!rows.has(doc.tokenHash)) rows.set(doc.tokenHash, doc);
    },
  };
};

const sign = (payload = { _id: "64b000000000000000000001" }, opts = {}) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "30d", ...opts });

const recorder = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

test("a revoked token is refused; others are not", async () => {
  const deps = memory();
  const token = sign();
  const other = sign({ _id: "64b000000000000000000002" });
  assert.equal(await isSessionRevoked(token, deps), false);
  assert.equal(await revokeSession(token, deps), true);
  assert.equal(await isSessionRevoked(token, deps), true);
  assert.equal(await isSessionRevoked(other, deps), false);
});

test("only a hash is stored, kept until the token would expire", async () => {
  const deps = memory();
  const token = sign();
  await revokeSession(token, deps);
  const [row] = [...deps.rows.values()];
  assert.equal(row.tokenHash, hashSessionToken(token));
  assert.ok(!JSON.stringify(row).includes(token));
  const { exp } = jwt.decode(token);
  assert.equal(row.expiresAt.getTime(), exp * 1000);
  assert.equal(String(row.userId), "64b000000000000000000001");
});

test("invalid or expired tokens need no revoking", async () => {
  const deps = memory();
  assert.equal(await revokeSession("not-a-jwt", deps), false);
  assert.equal(
    await revokeSession(sign(undefined, { expiresIn: -10 }), deps),
    false,
  );
  assert.equal(await revokeSession("", deps), false);
  assert.equal(deps.rows.size, 0);
});

test("without a database connection the check does not block", async () => {
  const deps = { ...memory(), connected: () => false };
  deps.findOne = async () => {
    throw new Error("should not query");
  };
  assert.equal(await isSessionRevoked(sign(), deps), false);
});

test("logout revokes both headers and always answers 200", async () => {
  const revoked = [];
  const token = sign();
  const session = sign({ _id: "64b000000000000000000003" });
  const req = {
    get: (name) =>
      ({ authorization: `Bearer ${token}`, "x-aquakart-session": session })[
        name.toLowerCase()
      ],
  };
  const res = recorder();
  await logout(req, res, {
    revokeSession: async (t) => {
      revoked.push(t);
      return true;
    },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(revoked.sort(), [token, session].sort());

  const none = recorder();
  await logout({ get: () => undefined }, none, {
    revokeSession: async () => assert.fail("nothing to revoke"),
  });
  assert.equal(none.statusCode, 200);
});

test("logout reports a storage failure instead of pretending", async () => {
  const res = recorder();
  await logout({ get: () => `Bearer ${sign()}` }, res, {
    revokeSession: async () => {
      throw new Error("db down");
    },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.success, false);
});
