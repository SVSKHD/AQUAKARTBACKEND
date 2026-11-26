import { transit } from "../../services/transit/index.js";
import { TransitError } from "../../services/transit/rules.js";
import { PARSE_MAX_CHARS } from "../../services/transit/extraction.js";
import { GeminiError } from "../../services/gemini.js";
import { staffHasPermission } from "../../middleware/permissions.js";

// HTTP layer for Transit (docs/TRANSIT.md). Business rules live in
// src/services/transit; this file maps requests, actors and errors only.
// Errors never echo customer phone numbers or addresses.

const actorOf = (req) => ({
  id: String(req.user._id),
  name:
    [req.user.firstName, req.user.lastName].filter(Boolean).join(" ").trim() ||
    req.user.email ||
    "",
  can: (permission) => staffHasPermission(req.user, permission),
});

export const sendTransitError = (res, error) => {
  if (error instanceof TransitError || error instanceof GeminiError)
    return res.status(error.status).json({
      success: false,
      code: error.code || "AI_UNAVAILABLE",
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  console.error("Transit request failed", {
    code: error?.code,
    message: error?.message,
  });
  return res.status(500).json({
    success: false,
    code: "SERVER_ERROR",
    message: "Something went wrong",
  });
};

const handle =
  (fn, status = 200) =>
  async (req, res) => {
    try {
      const data = await fn(req, actorOf(req));
      return res
        .status(typeof status === "function" ? status(data) : status)
        .json({
          success: true,
          data,
        });
    } catch (error) {
      return sendTransitError(res, error);
    }
  };

const key = (req) => req.header("Idempotency-Key") || req.body?.idempotencyKey;

// ---- Transporter workflow ----
export const parseText = handle(async (req) => {
  const source = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!source)
    throw new TransitError(
      400,
      "VALIDATION_FAILED",
      "Enter the delivery details first",
    );
  if (source.length > PARSE_MAX_CHARS)
    throw new TransitError(
      400,
      "VALIDATION_FAILED",
      `Keep the text under ${PARSE_MAX_CHARS} characters`,
    );
  return transit.parseText(source);
});
export const preview = handle((req) => transit.preview(req.body || {}));
export const submit = handle(
  (req, actor) => transit.submit(req.body || {}, actor, key(req)),
  (data) => (data.replayed ? 200 : 201),
);
export const listTransits = handle((req, actor) =>
  transit.list(req.query, actor),
);
export const getTransit = handle((req, actor) =>
  transit.get(req.params.id, actor),
);
export const recordCollection = handle(
  (req, actor) =>
    transit.recordCollection(req.params.id, req.body || {}, actor),
  (data) => (data.duplicate ? 200 : 201),
);
export const retryInvoiceDelivery = handle((req, actor) =>
  transit.retryInvoiceDelivery(req.params.id, actor),
);
export const myPayouts = handle((_req, actor) => transit.payoutSummary(actor));
export const getWarehouse = handle(() => transit.getWarehouse());

// ---- Admin ----
export const setWarehouse = handle((req, actor) =>
  transit.setWarehouse(req.body || {}, actor),
);
export const listRateCards = handle(() => transit.listRateCards());
export const createRateCard = handle(
  (req, actor) => transit.createRateCard(req.body || {}, actor),
  201,
);
export const updateRateCard = handle((req, actor) =>
  transit.updateRateCard(req.params.id, req.body || {}, actor),
);
export const listBenchmarks = handle(() => transit.listBenchmarks());
export const createBenchmark = handle(
  (req, actor) => transit.createBenchmark(req.body || {}, actor),
  201,
);
export const updateBenchmark = handle((req, actor) =>
  transit.updateBenchmark(req.params.id, req.body || {}, actor),
);
export const compareRates = handle((req, actor) =>
  transit.compare(req.query, actor),
);
export const reviewCollection = handle((req, actor) =>
  transit.reviewCollection(
    req.params.id,
    req.params.collectionId,
    req.body || {},
    actor,
  ),
);
export const approvePaymentException = handle((req, actor) =>
  transit.approvePaymentException(req.params.id, req.body || {}, actor),
);
export const correctDelivery = handle((req, actor) =>
  transit.correctDelivery(req.params.id, req.body || {}, actor),
);
export const cancelTransit = handle((req, actor) =>
  transit.cancel(req.params.id, req.body || {}, actor),
);
export const settle = handle(
  (req, actor) => transit.settle(req.body || {}, actor, key(req)),
  (data) => (data.replayed ? 200 : 201),
);
export const listSettlements = handle((req) =>
  transit.listSettlementBatches(req.query),
);
export const report = handle((req) => transit.report(req.query));
