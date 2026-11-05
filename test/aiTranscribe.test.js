import assert from "node:assert/strict";
import test from "node:test";
import AiUsage from "../src/models/aiUsage.js";
import AIOperations from "../src/controllers/ai.js";
import { transcribeAudio } from "../src/services/gemini.js";

const AUDIO = Buffer.from("fake opus bytes").toString("base64");

const okResponse = (text) => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
});

const run = async (body, req = {}) => {
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
  await AIOperations.transcribe({ ip: "1.2.3.4", body, ...req }, res);
  return res;
};

const usedToday = (t, count) =>
  t.mock.method(AiUsage, "findOne", () => ({
    select: () => ({ lean: async () => ({ count }) }),
  }));

test("sends the clip inline and returns only the words", async (t) => {
  process.env.GEMINI_KEY = "test-key";
  t.after(() => delete process.env.GEMINI_KEY);
  let sent;
  const result = await transcribeAudio({
    audio: AUDIO,
    mimeType: "audio/webm",
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(init.body);
      return okResponse("  Which softener fits a 3BHK flat?\n");
    },
  });
  assert.equal(result.text, "Which softener fits a 3BHK flat?");
  assert.deepEqual(sent.contents[0].parts[0], {
    inlineData: { mimeType: "audio/webm", data: AUDIO },
  });
  assert.equal(sent.generationConfig.temperature, 0);
  assert.match(sent.systemInstruction.parts[0].text, /Transcribe/);
});

test("no clear speech comes back empty", async (t) => {
  process.env.GEMINI_KEY = "test-key";
  t.after(() => delete process.env.GEMINI_KEY);
  const result = await transcribeAudio({
    audio: AUDIO,
    mimeType: "audio/webm",
    fetchImpl: async () => okResponse("[no speech]"),
  });
  assert.equal(result.text, "");
});

test("rejects unsupported formats, bad data and long clips before any AI call", async () => {
  let res = await run({ audio: AUDIO, mimeType: "video/mp4" });
  assert.equal(res.statusCode, 400);
  res = await run({ audio: "not base64!", mimeType: "audio/webm" });
  assert.equal(res.statusCode, 400);
  res = await run({
    audio: "A".repeat(1.5 * 1024 * 1024),
    mimeType: "audio/webm;codecs=opus",
  });
  assert.equal(res.statusCode, 413);
});

test("needs questions left today", async (t) => {
  usedToday(t, 99);
  const res = await run({ audio: AUDIO, mimeType: "audio/webm;codecs=opus" });
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, "AI_DAILY_LIMIT");
});
