import test from "node:test";
import assert from "node:assert/strict";
import {
  DOCUMENT_MAX_BYTES,
  documentProblem,
  normalizeReading,
  readInvoiceDocument,
} from "../src/services/aiInvoice/readDocument.js";

const photo = (bytes = 10, mimetype = "image/jpeg") => ({
  buffer: Buffer.alloc(bytes, 1),
  mimetype,
});

const fakeGenerate = (reply) => {
  const calls = [];
  const generate = async (options) => {
    calls.push(options);
    return { text: typeof reply === "string" ? reply : JSON.stringify(reply) };
  };
  return { generate, calls };
};

test("documentProblem refuses missing, wrong-type and oversized files", () => {
  assert.match(documentProblem(undefined), /Choose a photo/);
  assert.match(documentProblem(photo(10, "text/plain")), /JPG, PNG/);
  assert.match(documentProblem(photo(DOCUMENT_MAX_BYTES + 1)), /5 MB/);
  assert.equal(documentProblem(photo(10, "application/pdf")), "");
});

test("sends the file inline to Gemini and returns the reading", async () => {
  const { generate, calls } = fakeGenerate({
    text: "Ravi Traders\n98765 43210\nKondapur 500084\nbathroom softener 1 14950",
    gstin: "36aabcu9603r1zm",
    gstName: "Ravi Traders Pvt Ltd",
    gstAddress: "Plot 4, Kondapur, Hyderabad 500084",
    warnings: [],
  });
  const reading = await readInvoiceDocument(photo(), { generate });
  assert.equal(calls.length, 1);
  const part = calls[0].contents[0].parts[0].inlineData;
  assert.equal(part.mimeType, "image/jpeg");
  assert.equal(part.data, Buffer.alloc(10, 1).toString("base64"));
  assert.equal(calls[0].json, true);
  assert.equal(reading.gstin, "36AABCU9603R1ZM");
  assert.match(reading.text, /bathroom softener/);
});

test("drops a malformed GSTIN with a warning", () => {
  const reading = normalizeReading({ text: "Ravi", gstin: "36AABCU96" });
  assert.equal(reading.gstin, "");
  assert.match(reading.warnings[0], /doesn't look complete/);
});

test("422 when nothing useful is in the file", async () => {
  const { generate } = fakeGenerate({
    text: "",
    gstin: "",
    warnings: ["The photo is blank."],
  });
  await assert.rejects(readInvoiceDocument(photo(), { generate }), {
    statusCode: 422,
    message: "The photo is blank.",
  });
});

test("502 when Gemini answers with something that isn't JSON", async () => {
  const { generate } = fakeGenerate("not json");
  await assert.rejects(readInvoiceDocument(photo(), { generate }), {
    statusCode: 502,
  });
});

test("400 before any Gemini call for a bad file", async () => {
  const { generate, calls } = fakeGenerate({});
  await assert.rejects(
    readInvoiceDocument(photo(10, "application/zip"), { generate }),
    { statusCode: 400 },
  );
  assert.equal(calls.length, 0);
});
