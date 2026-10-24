import test from "node:test";
import assert from "node:assert/strict";
import {
  GeminiError,
  buildContents,
  generateContent,
  parseThoughtSteps,
  streamContent,
} from "../src/services/gemini.js";

const okResponse = (data) => ({
  ok: true,
  status: 200,
  json: async () => data,
});

test("builds Gemini contents from history and prompt", () => {
  const contents = buildContents({
    prompt: " Which softener? ",
    history: [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Hello!" },
      { role: "user", text: "  " },
    ],
  });
  assert.deepEqual(contents, [
    { role: "user", parts: [{ text: "Hi" }] },
    { role: "model", parts: [{ text: "Hello!" }] },
    { role: "user", parts: [{ text: "Which softener?" }] },
  ]);
});

test("sends the key in a header and returns the reply text", async (t) => {
  t.after(() => delete process.env.GEMINI_KEY);
  process.env.GEMINI_KEY = "test-key";
  let captured;
  const result = await generateContent({
    prompt: "Hello",
    systemInstruction: "Be brief",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return okResponse({
        candidates: [
          {
            content: { parts: [{ text: "Hi " }, { text: "there" }] },
            finishReason: "STOP",
          },
        ],
      });
    },
  });

  assert.equal(result.text, "Hi there");
  assert.equal(captured.init.headers["x-goog-api-key"], "test-key");
  assert.ok(!captured.url.includes("test-key"));
  const body = JSON.parse(captured.init.body);
  assert.equal(body.systemInstruction.parts[0].text, "Be brief");
});

test("reports missing configuration as 503", async () => {
  delete process.env.GEMINI_KEY;
  await assert.rejects(
    generateContent({ prompt: "Hello", fetchImpl: async () => okResponse({}) }),
    (error) => error instanceof GeminiError && error.status === 503,
  );
});

test("maps upstream rate limiting to 429", async (t) => {
  t.after(() => delete process.env.GEMINI_KEY);
  process.env.GEMINI_KEY = "test-key";
  await assert.rejects(
    generateContent({
      prompt: "Hello",
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "quota" } }),
      }),
    }),
    (error) => error instanceof GeminiError && error.status === 429,
  );
});

test("splits thought summaries into titled steps", () => {
  assert.deepEqual(
    parseThoughtSteps(
      "**Assessing Water Quality**\n\nTDS is high.\n\n**Choosing Products**\nRO plus softener.",
    ),
    [
      { title: "Assessing Water Quality", text: "TDS is high." },
      { title: "Choosing Products", text: "RO plus softener." },
    ],
  );
});

test("keeps thoughts out of the reply and returns them when thinking", async (t) => {
  t.after(() => delete process.env.GEMINI_KEY);
  process.env.GEMINI_KEY = "test-key";
  let body;
  const result = await generateContent({
    prompt: "RO or softener?",
    thinking: "medium",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return okResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "**Assessing**\n\nHard water.", thought: true },
                { text: "Both." },
              ],
            },
          },
        ],
      });
    },
  });
  assert.equal(result.text, "Both.");
  assert.deepEqual(result.thoughts, [
    { title: "Assessing", text: "Hard water." },
  ]);
  assert.deepEqual(body.generationConfig.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: "medium",
  });
});

test("streams thought steps, answer deltas and a final summary", async (t) => {
  t.after(() => delete process.env.GEMINI_KEY);
  process.env.GEMINI_KEY = "test-key";
  const sse = [
    { parts: [{ text: "**Assessing**\n\nHard", thought: true }] },
    { parts: [{ text: " water.", thought: true }] },
    { parts: [{ text: "**Deciding**\n\nBoth.", thought: true }] },
    { parts: [{ text: "You need " }] },
    { parts: [{ text: "both." }], finishReason: "STOP" },
  ]
    .map(
      ({ parts, finishReason }) =>
        `data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason }] })}\r\n\r\n`,
    )
    .join("");
  // Split mid-event to exercise buffering.
  const encoded = new TextEncoder().encode(sse);
  const chunks = [
    encoded.slice(0, 37),
    encoded.slice(37, 200),
    encoded.slice(200),
  ];

  const events = await streamContent({
    prompt: "RO or softener?",
    thinking: "high",
    fetchImpl: async () => ({ ok: true, status: 200, body: chunks }),
  });
  const received = [];
  for await (const event of events) received.push(event);

  assert.deepEqual(
    received.filter((e) => e.type === "thought").map((e) => [e.index, e.text]),
    [
      [0, "Hard"],
      [0, "Hard water."],
      [1, "Both."],
    ],
  );
  assert.equal(
    received
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
    "You need both.",
  );
  const done = received.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.reply, "You need both.");
  assert.equal(done.thoughts.length, 2);
});
