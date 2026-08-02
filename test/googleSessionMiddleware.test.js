import assert from "node:assert/strict";
import test from "node:test";
import requireGoogleBackendSession from "../src/middleware/googleSession.js";

const responseRecorder = () => {
  const response = { statusCode: 200, body: null };
  response.status = (statusCode) => {
    response.statusCode = statusCode;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
};

test("requires the backend session created by the Google handshake", async () => {
  const req = {
    get: () => "",
    firebaseUser: { uid: "firebase-customer-1" },
  };
  const res = responseRecorder();
  await requireGoogleBackendSession(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /complete google sign-in/i);
});

test("rejects an invalid backend session without echoing it", async () => {
  process.env.JWT_SECRET = "google-session-test-secret";
  const req = {
    get: () => "invalid-backend-session",
    firebaseUser: { uid: "firebase-customer-1" },
  };
  const res = responseRecorder();
  await requireGoogleBackendSession(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.equal(
    JSON.stringify(res.body).includes("invalid-backend-session"),
    false,
  );
});
