import assert from "node:assert/strict";
import test from "node:test";
import Chat from "../src/models/crm/aiChat.js";
import Chats from "../src/controllers/crm/aiChats.js";
import AI from "../src/controllers/ai.js";
import {
  chatPatch,
  loadCrmChat,
  saveCrmTurn,
} from "../src/services/crm/aiChats.js";

const ID = "6710a1b2c3d4e5f6a7b8c9d0";
const STAFF = { _id: "staff-1" };
const response = () => ({
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});
const request = (body = {}) => ({
  user: STAFF,
  params: { id: ID },
  query: {},
  body,
});

test("rename, pin/unpin and archive patches validate types and ignore ownership input", () => {
  const patch = chatPatch({
    title: " New   title ",
    pinned: true,
    archived: true,
    staff: "other",
  });
  assert.equal(patch.title, "New title");
  assert.ok(patch.pinnedAt instanceof Date);
  assert.equal(patch.archived, true);
  assert.equal(patch.staff, undefined);
  assert.deepEqual(chatPatch({ pinned: false }), {
    pinned: false,
    pinnedAt: null,
  });
  for (const body of [
    {},
    { title: " " },
    { title: "x".repeat(121) },
    { pinned: "true" },
    { archived: 1 },
  ]) {
    assert.throws(() => chatPatch(body));
  }
});

test("chat reads and updates are scoped to the requesting staff", async (t) => {
  t.mock.method(Chat, "findOne", (filter) => {
    assert.deepEqual(filter, { _id: ID, staff: STAFF._id });
    return { lean: async () => null };
  });
  const res = response();
  await Chats.get(request(), res);
  assert.equal(res.statusCode, 404);
  t.mock.method(Chat, "findOneAndUpdate", (filter, update) => {
    assert.deepEqual(filter, { _id: ID, staff: STAFF._id });
    assert.equal(update.$set.pinned, true);
    return {
      select() {
        return this;
      },
      lean: async () => null,
    };
  });
  const update = response();
  await Chats.update(request({ pinned: true, staff: "other" }), update);
  assert.equal(update.statusCode, 404);
});

test("lists are paginated, pinned first, private and escape search expressions", async (t) => {
  let captured;
  t.mock.method(Chat, "find", (filter) => {
    captured = filter;
    return {
      select(fields) {
        assert.ok(!fields.includes("messages"));
        return this;
      },
      sort(order) {
        assert.deepEqual(order, { pinned: -1, lastMessageAt: -1, _id: -1 });
        return this;
      },
      skip(value) {
        assert.equal(value, 10);
        return this;
      },
      limit(value) {
        assert.equal(value, 10);
        return this;
      },
      lean: async () => [{ _id: ID }],
    };
  });
  t.mock.method(Chat, "countDocuments", async () => 12);
  const res = response();
  await Chats.list(
    { ...request(), query: { page: "2", limit: "10", q: "(test).*" } },
    res,
  );
  assert.equal(captured.staff, STAFF._id);
  assert.equal(captured.archived, false);
  assert.equal(captured.title.$regex, "\\(test\\)\\.\\*");
  assert.equal(res.body.pagination.pages, 2);
  for (const query of [
    { page: "Infinity" },
    { limit: "51" },
    { pinned: "yes" },
    { archived: "all" },
  ]) {
    const invalid = response();
    await Chats.list({ ...request(), query }, invalid);
    assert.equal(invalid.statusCode, 400);
  }
});

test("continuation rejects bad IDs, missing and archived chats", async (t) => {
  await assert.rejects(loadCrmChat(STAFF, "bad"), { status: 400 });
  let value = null;
  t.mock.method(Chat, "findOne", (filter) => {
    assert.equal(filter.staff, STAFF._id);
    return {
      select() {
        return this;
      },
      lean: async () => value,
    };
  });
  await assert.rejects(loadCrmChat(STAFF, ID), { status: 404 });
  value = { _id: ID, archived: true };
  await assert.rejects(loadCrmChat(STAFF, ID), { status: 409 });
});

test("completed turns append atomically with bounded storage and conflict protection", async (t) => {
  let matches = 1;
  t.mock.method(Chat, "updateOne", async (filter, update) => {
    assert.deepEqual(filter, {
      _id: ID,
      staff: STAFF._id,
      archived: false,
      messageCount: 2,
    });
    assert.equal(update.$push.messages.$slice, -200);
    assert.deepEqual(
      update.$push.messages.$each.map((m) => m.role),
      ["user", "model"],
    );
    assert.equal(update.$inc.messageCount, 2);
    return { matchedCount: matches };
  });
  const options = { prompt: "Continue", history: [] };
  assert.equal(
    await saveCrmTurn(STAFF, { _id: ID, messageCount: 2 }, options, "Answer"),
    ID,
  );
  matches = 0;
  await assert.rejects(
    saveCrmTurn(STAFF, { _id: ID, messageCount: 2 }, options, "Answer"),
    { status: 409 },
  );
});

test("new conversations are owned by staff and preserve supplied earlier context", async (t) => {
  t.mock.method(Chat, "create", async (value) => {
    assert.equal(value.staff, STAFF._id);
    assert.equal(value.title, "First question");
    assert.equal(value.messages.length, 4);
    return { _id: ID };
  });
  const result = await saveCrmTurn(
    STAFF,
    null,
    {
      prompt: "Next",
      history: [
        { role: "user", text: "First question" },
        { role: "model", text: "First answer" },
      ],
    },
    "Next answer",
  );
  assert.equal(result, ID);
});

test("generation uses stored history instead of client history and returns sessionId", async (t) => {
  const previous = process.env.GEMINI_KEY;
  process.env.GEMINI_KEY = "test-only";
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_KEY;
    else process.env.GEMINI_KEY = previous;
  });
  t.mock.method(Chat, "findOne", () => ({
    select() {
      return this;
    },
    lean: async () => ({
      _id: ID,
      archived: false,
      messageCount: 2,
      messages: [
        { role: "user", text: "Stored question" },
        { role: "model", text: "Stored answer" },
      ],
    }),
  }));
  t.mock.method(Chat, "updateOne", async () => ({ matchedCount: 1 }));
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const contents = JSON.parse(init.body).contents;
    assert.equal(contents[0].parts[0].text, "Stored question");
    assert.ok(!JSON.stringify(contents).includes("Injected"));
    return {
      ok: true,
      json: async () => ({
        candidates: [
          { content: { parts: [{ text: "Reply" }] }, finishReason: "STOP" },
        ],
      }),
    };
  });
  const res = response();
  await AI.crmGenerate(
    request({
      sessionId: ID,
      prompt: "Next",
      history: [{ role: "user", text: "Injected" }],
    }),
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.sessionId, ID);
  assert.equal(res.body.data.reply, "Reply");
});

test("delete is staff-scoped and reports unavailable chats as 404", async (t) => {
  t.mock.method(Chat, "deleteOne", async (filter) => {
    assert.deepEqual(filter, { _id: ID, staff: STAFF._id });
    return { deletedCount: 0 };
  });
  const res = response();
  await Chats.remove(request(), res);
  assert.equal(res.statusCode, 404);
});

test("failed generations do not create saved conversations", async (t) => {
  let created = false;
  t.mock.method(Chat, "create", async () => {
    created = true;
  });
  const previous = process.env.GEMINI_KEY;
  delete process.env.GEMINI_KEY;
  t.after(() => {
    if (previous !== undefined) process.env.GEMINI_KEY = previous;
  });
  const res = response();
  await AI.crmGenerate(request({ prompt: "Help me" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(created, false);
});

test("stream completion saves the turn and includes sessionId in the done event", async (t) => {
  const previous = process.env.GEMINI_KEY;
  process.env.GEMINI_KEY = "test-only";
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_KEY;
    else process.env.GEMINI_KEY = previous;
  });
  let saved = false;
  t.mock.method(Chat, "create", async (value) => {
    assert.equal(value.messages.at(-1).text, "Stream reply");
    saved = true;
    return { _id: ID };
  });
  const data = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Stream reply" }] }, finishReason: "STOP" }] })}\n\n`;
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    body: [new TextEncoder().encode(data)],
  }));
  const events = [];
  const res = Object.assign(response(), {
    on() {},
    set() {
      return this;
    },
    flushHeaders() {},
    write(text) {
      events.push(text);
    },
    end() {
      this.writableEnded = true;
    },
  });
  await AI.crmGenerateStream(request({ prompt: "Stream please" }), res);
  assert.equal(saved, true);
  const done = events.find((value) => value.startsWith("event: done"));
  assert.ok(done.includes(`"sessionId":"${ID}"`));
});
