import assert from "node:assert/strict";
import test from "node:test";
import AiChatSession from "../src/models/aiChatSession.js";
import AIOperations from "../src/controllers/ai.js";

const ID = "6710a1b2c3d4e5f6a7b8c9d0";
const USER = { _id: "user-1" };

const run = async (body, id = ID) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await AIOperations.updateChatSession(
    { params: { id }, body, user: USER },
    res,
  );
  return res;
};

const stubUpdate = (t, result = { _id: ID, title: "x", pinned: false }) => {
  const calls = [];
  t.mock.method(AiChatSession, "findOneAndUpdate", (filter, update) => {
    calls.push({ filter, update });
    return { lean: async () => result };
  });
  return calls;
};

test("renames the customer's own chat, tidying whitespace", async (t) => {
  const calls = stubUpdate(t);
  const res = await run({ title: "  Softener   for my villa " });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].filter, { _id: ID, user: "user-1" });
  assert.deepEqual(calls[0].update, {
    $set: { title: "Softener for my villa" },
  });
});

test("pins and unpins, stamping when it was pinned", async (t) => {
  const calls = stubUpdate(t);
  await run({ pinned: true });
  assert.equal(calls[0].update.$set.pinned, true);
  assert.ok(calls[0].update.$set.pinnedAt instanceof Date);
  await run({ pinned: false });
  assert.deepEqual(calls[1].update.$set, { pinned: false, pinnedAt: null });
});

test("rejects empty or overlong titles, non-boolean pins and empty updates", async (t) => {
  const calls = stubUpdate(t);
  assert.equal((await run({ title: "   " })).statusCode, 400);
  assert.equal((await run({ title: "x".repeat(81) })).statusCode, 400);
  assert.equal((await run({ pinned: "yes" })).statusCode, 400);
  assert.equal((await run({})).statusCode, 400);
  assert.equal(calls.length, 0);
});

test("a chat that isn't the customer's (or a bad id) is not found", async (t) => {
  stubUpdate(t, null);
  assert.equal((await run({ pinned: true })).statusCode, 404);
  assert.equal((await run({ pinned: true }, "not-an-id")).statusCode, 404);
});
