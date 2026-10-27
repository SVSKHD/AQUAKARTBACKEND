import test from "node:test";
import assert from "node:assert/strict";
import User from "../src/models/user.js";
import Chat from "../src/models/aiChatSession.js";
import Blog from "../src/models/blog.js";
import Category from "../src/models/category.js";
import SubCategory from "../src/models/sub-category.js";
import Product from "../src/models/product.js";
import Users, { USER_FIELDS } from "../src/controllers/crm/aiUsers.js";
import Blogs from "../src/controllers/blog.js";
import {
  canReviewCustomerChats,
  canDraftCustomerBlogs,
} from "../src/routes/crm/ai.js";
import {
  questionAnswers,
  selectQuestions,
  redactCustomerText,
  editorialHtml,
  generateCustomerBlog,
} from "../src/services/crm/customerAi.js";

const USER = "6710a1b2c3d4e5f6a7b8c9d0";
const CHAT = "6710a1b2c3d4e5f6a7b8c9d1";
const QUESTION = "6710a1b2c3d4e5f6a7b8c9d2";
const ANSWER = "6710a1b2c3d4e5f6a7b8c9d3";
const profile = {
  _id: USER,
  firstName: "Jane",
  lastName: "Sample",
  email: "jane@example.com",
  phone: 9876543210,
};
const messages = [
  {
    _id: QUESTION,
    role: "user",
    text: "Jane Sample: hard water help, jane@example.com or 9876543210",
  },
  { _id: ANSWER, role: "model", text: "Check water hardness first." },
];
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
const req = () => ({
  params: { userId: USER, chatId: CHAT },
  query: {},
  body: {},
  user: { _id: "staff-1", role: 1 },
});
const chain = (value) => ({
  select() {
    return this;
  },
  sort() {
    return this;
  },
  skip() {
    return this;
  },
  limit() {
    return this;
  },
  lean: async () => value,
});
const mockContext = (t) => {
  for (const model of [Category, SubCategory, Product, Blog])
    t.mock.method(model, "find", () => chain([]));
};

test("question selection pairs answers, excludes unanswered prompts and validates source IDs", () => {
  assert.equal(
    questionAnswers([
      ...messages,
      { _id: USER, role: "user", text: "Unanswered" },
    ]).length,
    1,
  );
  assert.equal(selectQuestions(messages, [QUESTION])[0].answerId, ANSWER);
  assert.throws(() => selectQuestions(messages, [ANSWER]));
  assert.throws(() => selectQuestions(messages, [QUESTION, QUESTION]));
  assert.throws(() => selectQuestions([], undefined));
});

test("permissions separate customer review from ordinary staff AI and blog creation", () => {
  let allowed = false;
  const denied = response();
  canReviewCustomerChats({ user: { role: 2 } }, denied, () => {
    allowed = true;
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(allowed, false);
  canReviewCustomerChats(
    { user: { directPermissions: ["customers.read", "ai.chats.read"] } },
    response(),
    () => {
      allowed = true;
    },
  );
  assert.equal(allowed, true);
  const noBlog = response();
  canDraftCustomerBlogs(
    { user: { directPermissions: ["customers.read", "ai.chats.read"] } },
    noBlog,
    () => {},
  );
  assert.equal(noBlog.statusCode, 403);
  allowed = false;
  canDraftCustomerBlogs({ user: { role: 1 } }, response(), () => {
    allowed = true;
  });
  assert.equal(allowed, true);
});

test("CRM directory uses explicit safe fields and paginated chat statistics", async (t) => {
  for (const field of [
    "password",
    "emailOtp",
    "resetPasswordOtp",
    "googleData",
    "firebaseUid",
  ])
    assert.ok(!USER_FIELDS.split(" ").includes(field));
  t.mock.method(User, "find", (filter) => {
    assert.equal(filter.$or[0].firstName.source, "Jane\\.");
    const query = chain([profile]);
    query.select = (fields) => {
      assert.equal(fields, USER_FIELDS);
      return query;
    };
    return query;
  });
  t.mock.method(User, "countDocuments", async () => 1);
  t.mock.method(Chat, "aggregate", async (pipeline) => {
    assert.equal(String(pipeline[0].$match.user.$in[0]), USER);
    return [{ _id: USER, chats: 2, messages: 4, lastMessageAt: null }];
  });
  const res = response();
  await Users.list({ ...req(), query: { q: "Jane." } }, res);
  assert.equal(res.body.data[0].ai.chats, 2);
  assert.equal(res.body.pagination.total, 1);
});

test("reading a customer conversation requires the user/chat relationship", async (t) => {
  t.mock.method(User, "findById", () => chain(profile));
  t.mock.method(Chat, "findOne", (filter) => {
    assert.deepEqual(filter, { _id: CHAT, user: USER });
    return chain(null);
  });
  const res = response();
  await Users.chat(req(), res);
  assert.equal(res.statusCode, 404);
});

test("conversation details expose Q/A message IDs for editorial selection", async (t) => {
  t.mock.method(User, "findById", () => chain(profile));
  t.mock.method(Chat, "findOne", () =>
    chain({ _id: CHAT, user: USER, messages }),
  );
  const res = response();
  await Users.chat(req(), res);
  assert.equal(res.body.data.qa[0].questionId, QUESTION);
  assert.equal(res.body.data.qa[0].answer, messages[1].text);
});

test("redacts known names, emails, phones, links and IDs from article source", () => {
  const text = redactCustomerText(
    `Jane Sample jane@example.com +91 98765 43210 ${USER} https://example.com/private`,
    profile,
  );
  for (const privateValue of [
    "Jane",
    "Sample",
    "jane@example.com",
    "98765",
    USER,
    "example.com",
  ])
    assert.ok(!text.includes(privateValue));
});

test("editorial HTML drops executable tags, event handlers and every attribute", () => {
  const html = editorialHtml(
    '<h2 onclick="x()">Guide</h2><script>alert(1)</script><img src=x onerror=x><a href=javascript:alert(1)>Read</a>',
  );
  assert.equal(html, "<h2>Guide</h2><a>Read</a>");
});

test("blog generation uses redacted Q/A, persists a draft and CRM-only provenance", async (t) => {
  mockContext(t);
  let saved;
  t.mock.method(Blog, "create", async (value) => {
    saved = value;
    return { _id: "draft-1", ...value };
  });
  const result = await generateCustomerBlog({
    chat: { _id: CHAT, messages },
    user: profile,
    staff: { _id: "staff-1" },
    questionIds: [QUESTION],
    generate: async (options) => {
      assert.ok(!options.prompt.includes("jane@example.com"));
      assert.ok(!options.prompt.includes("Jane Sample"));
      assert.ok(options.prompt.includes("Check water hardness first"));
      return {
        text: JSON.stringify({
          title: "How to check water hardness at home",
          description: `<h2>Water guide</h2><p>${"water treatment guide ".repeat(130)}</p><img src=x onerror=alert(1)>`,
          status: "published",
        }),
        model: "test-model",
      };
    },
  });
  assert.equal(saved.status, "draft");
  assert.equal(saved.generatedBy, "ai");
  assert.deepEqual(saved.sourceAiQuestions, [QUESTION]);
  assert.equal(saved.sourceAiChat, CHAT);
  assert.equal(saved.sourceAiRequestedBy, "staff-1");
  assert.ok(!saved.description.includes("<img"));
  assert.equal(result.model, "test-model");
  assert.equal(Blog.schema.path("sourceAiChat").options.select, false);
});

test("invalid AI output does not persist a blog", async (t) => {
  mockContext(t);
  let saved = false;
  t.mock.method(Blog, "create", async () => {
    saved = true;
  });
  await assert.rejects(
    generateCustomerBlog({
      chat: { _id: CHAT, messages },
      user: profile,
      staff: { _id: "staff-1" },
      generate: async () => ({ text: "not JSON" }),
    }),
    { status: 502 },
  );
  assert.equal(saved, false);
});

test("public blog ID lookups exclude drafts while explicit staff lookup can load them", async (t) => {
  const filters = [];
  t.mock.method(Blog, "findOne", async (filter) => {
    filters.push(filter);
    return null;
  });
  const res = response();
  await Blogs.getBlogById({ params: { id: CHAT }, query: {} }, res);
  assert.deepEqual(filters[0], { _id: CHAT, status: { $ne: "draft" } });
  assert.equal(res.statusCode, 404);
  await Blogs.getBlogById(
    { params: { id: CHAT }, query: { status: "all" } },
    response(),
  );
  assert.deepEqual(filters[1], { _id: CHAT });
});
