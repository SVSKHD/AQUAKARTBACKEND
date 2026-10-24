const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Lite model keeps storefront latency ~1-2s; override with GEMINI_MODEL.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const REQUEST_TIMEOUT_MS = 60 * 1000;
const STREAM_TIMEOUT_MS = 90 * 1000;
// Thought tokens count against the output budget, so reserve room for them.
const THINKING_TOKEN_ALLOWANCE = 4096;
export const THINKING_LEVELS = ["medium", "high"];

export class GeminiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

export const isGeminiConfigured = () => Boolean(process.env.GEMINI_KEY);

// Accepts either a single prompt string or a chat history of
// { role: "user" | "model" | "assistant", text } entries.
export const buildContents = ({ prompt, history = [] }) => {
  const contents = history
    .filter((entry) => typeof entry?.text === "string" && entry.text.trim())
    .map((entry) => ({
      role: entry.role === "user" ? "user" : "model",
      parts: [{ text: entry.text.trim() }],
    }));

  if (typeof prompt === "string" && prompt.trim()) {
    contents.push({ role: "user", parts: [{ text: prompt.trim() }] });
  }

  return contents;
};

const answerParts = (data) =>
  (data?.candidates?.[0]?.content?.parts || []).filter(
    (part) => part?.text && !part.thought,
  );

export const extractText = (data) =>
  answerParts(data)
    .map((part) => part.text)
    .join("")
    .trim();

// Gemini thought summaries are markdown with a bold heading per step:
// "**Assessing Water Quality**\n\nI'm looking at...". Split them into steps.
export const parseThoughtSteps = (text = "") => {
  const steps = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = line.match(/^\s*\*\*(.+?)\*\*\s*$/);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      steps.push(current);
    } else {
      if (!current) {
        current = { title: null, lines: [] };
        steps.push(current);
      }
      current.lines.push(line);
    }
  }
  return steps
    .map((step) => ({ title: step.title, text: step.lines.join("\n").trim() }))
    .filter((step) => step.title || step.text);
};

const joinThoughtChunk = (raw, chunk) =>
  raw && !raw.endsWith("\n") && /^\s*\*\*/.test(chunk)
    ? `${raw}\n\n${chunk}`
    : raw + chunk;

const extractThoughts = (data) =>
  parseThoughtSteps(
    (data?.candidates?.[0]?.content?.parts || [])
      .filter((part) => part?.thought && part.text)
      .reduce((raw, part) => joinThoughtChunk(raw, part.text), ""),
  );

const buildRequest = ({
  prompt,
  history,
  systemInstruction,
  temperature = 0.7,
  maxOutputTokens = 1024,
  json = false,
  thinking = null,
  stream = false,
  contents: rawContents,
  tools,
  model: modelOverride,
}) => {
  const apiKey = process.env.GEMINI_KEY;
  if (!apiKey) throw new GeminiError("Gemini is not configured", 503);

  const contents = rawContents || buildContents({ prompt, history });
  if (!contents.length) throw new GeminiError("Prompt is required", 400);

  const model = modelOverride || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const thinkingLevel = THINKING_LEVELS.includes(thinking) ? thinking : null;
  const body = {
    contents,
    generationConfig: {
      temperature,
      maxOutputTokens: thinkingLevel
        ? maxOutputTokens + THINKING_TOKEN_ALLOWANCE
        : maxOutputTokens,
      ...(json ? { responseMimeType: "application/json" } : {}),
      ...(thinkingLevel
        ? { thinkingConfig: { includeThoughts: true, thinkingLevel } }
        : {}),
    },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  if (tools?.length) {
    body.tools = [{ functionDeclarations: tools }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return {
    model,
    url: `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:${method}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    },
  };
};

const toGeminiError = (error) => {
  if (error instanceof GeminiError) return error;
  if (error?.name === "TimeoutError") {
    return new GeminiError("Gemini request timed out", 504);
  }
  if (error?.name === "AbortError") {
    return new GeminiError("Gemini request was cancelled", 499);
  }
  return new GeminiError("Gemini request failed", 502);
};

const send = async (url, init, fetchImpl) => {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw toGeminiError(error);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    console.error("Gemini API error:", response.status, data?.error?.message);
    throw new GeminiError(
      response.status === 429
        ? "AI service is busy. Please try again shortly."
        : "AI service returned an error",
      response.status === 429 ? 429 : 502,
    );
  }
  return response;
};

const emptyReplyError = (blocked) =>
  new GeminiError(
    blocked
      ? "Request was blocked by the AI safety filter"
      : "Empty AI response",
    blocked ? 422 : 502,
  );

export const generateContent = async ({ fetchImpl = fetch, ...options }) => {
  const { model, url, init } = buildRequest(options);
  const response = await send(
    url,
    { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    fetchImpl,
  );

  const data = await response.json().catch(() => null);
  const text = extractText(data);
  if (!text) {
    throw emptyReplyError(
      data?.promptFeedback?.blockReason ||
        data?.candidates?.[0]?.finishReason === "SAFETY",
    );
  }

  return {
    text,
    thoughts: options.thinking ? extractThoughts(data) : [],
    model,
    finishReason: data?.candidates?.[0]?.finishReason || null,
    usage: data?.usageMetadata || null,
  };
};

// One function-calling step over raw Gemini `contents`. Returns the model's
// content verbatim (it carries thought signatures that must be sent back on
// the next step) plus any function calls it requested.
export const generateTurn = async ({ fetchImpl = fetch, ...options }) => {
  const { model, url, init } = buildRequest(options);
  const response = await send(
    url,
    { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    fetchImpl,
  );

  const data = await response.json().catch(() => null);
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const functionCalls = parts
    .filter((part) => part?.functionCall?.name)
    .map((part) => part.functionCall);
  const text = extractText(data);
  if (!text && !functionCalls.length) {
    throw emptyReplyError(
      data?.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY",
    );
  }

  return {
    content: { role: "model", parts },
    text,
    functionCalls,
    thoughts: options.thinking ? extractThoughts(data) : [],
    model,
    finishReason: candidate?.finishReason || null,
    usage: data?.usageMetadata || null,
  };
};

async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) yield JSON.parse(data);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function* streamEvents(body, model) {
  const thoughts = [];
  let rawThoughts = "";
  let reply = "";
  let finishReason = null;
  let usage = null;
  let blocked = false;

  for await (const data of readSse(body)) {
    const candidate = data?.candidates?.[0];
    for (const part of candidate?.content?.parts || []) {
      if (!part?.text) continue;
      if (part.thought) {
        rawThoughts = joinThoughtChunk(rawThoughts, part.text);
        // Re-parse and emit only steps that are new or grew, keyed by index.
        const steps = parseThoughtSteps(rawThoughts);
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index];
          const previous = thoughts[index];
          if (previous?.title === step.title && previous?.text === step.text) {
            continue;
          }
          thoughts[index] = step;
          yield { type: "thought", index, ...step };
        }
      } else {
        reply += part.text;
        yield { type: "text", text: part.text };
      }
    }
    finishReason = candidate?.finishReason || finishReason;
    usage = data?.usageMetadata || usage;
    if (data?.promptFeedback?.blockReason || finishReason === "SAFETY") {
      blocked = true;
    }
  }

  if (!reply.trim()) throw emptyReplyError(blocked);
  // A stream that ends without a finish reason was cut off upstream; don't
  // present the partial text as a complete answer.
  if (!finishReason) {
    throw new GeminiError(
      "The AI response was interrupted. Please try again.",
      502,
    );
  }
  yield {
    type: "done",
    reply: reply.trim(),
    thoughts,
    model,
    finishReason,
    usage,
  };
}

// Resolves once Gemini has accepted the request (so HTTP errors surface before
// the caller commits to a streaming response), then yields events:
// { type: "thought", index, title, text } — upsert by index
// { type: "text", text }                  — answer delta
// { type: "done", reply, thoughts, model, finishReason, usage }
export const streamContent = async ({
  fetchImpl = fetch,
  signal,
  ...options
}) => {
  const { model, url, init } = buildRequest({ ...options, stream: true });
  const timeout = AbortSignal.timeout(STREAM_TIMEOUT_MS);
  const response = await send(
    url,
    { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
    fetchImpl,
  );

  return (async function* events() {
    try {
      yield* streamEvents(response.body, model);
    } catch (error) {
      throw toGeminiError(error);
    }
  })();
};
