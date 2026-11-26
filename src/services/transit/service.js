import { toInvoicePayload } from "../aiInvoice/draft.js";
import { BENCHMARK_PROVIDERS } from "../../models/transit/benchmark.js";
import { COLLECTION_METHODS } from "../../models/transit/transit.js";
import {
  TransitError,
  currentRateCard,
  invoicePaidStatus,
  km,
  money,
  paymentSummary,
  payoutTotals,
  priceItems,
  priceSnapshot,
  requestHash,
  snapshotHash,
  validLatLng,
  validateRateCardInput,
  validateSubmission,
  verificationForMethod,
} from "./rules.js";

// Transit V1 (docs/TRANSIT.md). Business rules only; dependencies are
// injected so tests run on in-memory fakes:
//
//   store         persistence (src/services/transit/mongoStore.js)
//   invoiceWriter { validate, persist, assertStock } - the CRM invoice service
//   routing       { name, geocode, route } - src/services/routing
//   parse(text)   Gemini-assisted extraction (extraction.js)
//   notifier      { deliverInvoice({ invoice, dedupePrefix }) } - WhatsApp/SMS
//   comparison    rate comparison (comparison.js)
//   audit({ actor, action, resourceType, resourceId, metadata })
//   now()
//
// actor = { id, name, can(permission) }
//
// Rules that matter:
// - charges and payment status are computed here, never by Gemini;
// - a transit is only created once route and price are known; routing
//   failures or ambiguous destinations block submission;
// - submission is idempotent per (transporter, Idempotency-Key) and one
//   transit has at most one invoice (unique sourceTransitId);
// - delivery/pricing snapshots change only through correctDelivery (audited);
// - customer payment and transporter payout are independent.

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const ID_PATTERN = /^[a-f0-9]{24}$/i;
const LOCK_MS = 2 * 60 * 1000;
const STALE_SENDING_MS = 5 * 60 * 1000;
const MAX_SETTLE = 200;
const REPORT_LIMIT = 5000;
const COLLECTION_RETRIES = 3;

const id = (value) => (value ? String(value) : null);
const text = (value, max = 300) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const notFound = () => new TransitError(404, "NOT_FOUND", "Transit not found");
const requireKey = (key, label = "Idempotency-Key") => {
  const value = String(key || "").trim();
  if (!KEY_PATTERN.test(value))
    throw new TransitError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      `${label} header is required (8-100 letters, digits, - or _)`,
    );
  return value;
};
const requireId = (value) => {
  if (!ID_PATTERN.test(String(value || ""))) throw notFound();
  return String(value);
};
const requireManage = (actor) => {
  if (!actor.can("transit.manage"))
    throw new TransitError(403, "FORBIDDEN", "Insufficient permission");
};

const isStockError = (error) =>
  /stock/i.test(String(error?.message || "")) &&
  Number(error?.statusCode) === 400;

export const pageOf = (query = {}) => {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
};

const dateOr = (value, fallback) => {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new TransitError(400, "VALIDATION_FAILED", "Dates must be ISO dates");
  return date;
};

/** What clients see of a transit (internal locking fields removed). */
export const transitView = (doc) => {
  if (!doc) return null;
  const { requestHash: _hash, lockedUntil: _lock, __v: _v, ...rest } = doc;
  return {
    ...rest,
    id: id(doc._id),
    customerPayment: doc.customerPayment && {
      ...doc.customerPayment,
      balance: money(
        Math.max(
          0,
          Number(doc.customerPayment.amountDue) -
            Number(doc.customerPayment.amountConfirmed || 0),
        ),
      ),
    },
  };
};

export const createTransitService = ({
  store,
  invoiceWriter,
  routing,
  parse,
  notifier,
  comparison,
  audit = async () => {},
  now = () => new Date(),
}) => {
  const record = (actor, action, resourceId, metadata) =>
    audit({ actor, action, resourceType: "transit", resourceId, metadata });

  // ---- Access ------------------------------------------------------------------

  const canSeeAll = (actor) =>
    actor.can("transit.read") ||
    actor.can("transit.manage") ||
    actor.can("transit.settle");

  const loadAccessible = async (transitId, actor) => {
    const doc = await store.findTransit(requireId(transitId));
    if (!doc) throw notFound();
    // Someone else's transit is "not found", so ids can't be probed.
    if (!canSeeAll(actor) && id(doc.transporterId) !== actor.id)
      throw notFound();
    return doc;
  };

  // ---- Route and price -----------------------------------------------------------

  const activeWarehouse = async () => {
    const warehouse = await store.getActiveWarehouse();
    if (!warehouse || !validLatLng(warehouse.location))
      throw new TransitError(
        503,
        "WAREHOUSE_NOT_CONFIGURED",
        "The warehouse location is not set. An admin must set it before deliveries can be priced.",
      );
    return {
      id: warehouse._id,
      name: warehouse.name,
      address: warehouse.address,
      lat: Number(warehouse.location.lat),
      lng: Number(warehouse.location.lng),
    };
  };

  const routingFailure = (error) =>
    error instanceof TransitError
      ? error
      : new TransitError(
          error?.status || 502,
          error?.code || "ROUTING_PROVIDER_ERROR",
          error?.message || "Distance could not be calculated",
          error?.details,
        );

  /** Road route from the warehouse; never guesses a location or distance. */
  const resolveDelivery = async ({ address, destination }, warehouse) => {
    let target;
    try {
      if (destination) {
        target = {
          lat: destination.lat,
          lng: destination.lng,
          source: "pinned",
          placeId: "",
          formattedAddress: "",
        };
      } else {
        const found = await routing.geocode(address, {
          near: { lat: warehouse.lat, lng: warehouse.lng },
        });
        if (found.status === "not_found")
          throw new TransitError(
            422,
            "DESTINATION_NOT_FOUND",
            "The delivery address could not be found on the map. Pin the location.",
          );
        if (found.status !== "ok")
          throw new TransitError(
            422,
            "DESTINATION_AMBIGUOUS",
            "The delivery address is not precise enough to price. Pin the exact location or choose one of the matches.",
            { candidates: found.candidates || [] },
          );
        target = {
          lat: found.match.lat,
          lng: found.match.lng,
          source: "geocoded",
          placeId: found.match.placeId || "",
          formattedAddress: found.match.formattedAddress || "",
        };
      }
      const route = await routing.route(
        { lat: warehouse.lat, lng: warehouse.lng },
        { lat: target.lat, lng: target.lng },
      );
      return {
        address,
        formattedAddress: target.formattedAddress,
        destination: {
          lat: target.lat,
          lng: target.lng,
          source: target.source,
          placeId: target.placeId,
        },
        warehouse,
        distanceKm: km(route.distanceMeters),
        durationMinutes: Number.isFinite(route.durationSeconds)
          ? Math.round(route.durationSeconds / 60)
          : null,
        provider: routing.name,
        polyline: route.polyline || "",
        routedAt: now(),
      };
    } catch (error) {
      throw routingFailure(error);
    }
  };

  const rateCardInForce = async () =>
    currentRateCard(await store.listActiveRateCards(), now());

  /** Everything a submission needs, computed in code. Writes nothing. */
  const quote = async (submission, { stockBlocking }) => {
    const products = await store.loadProducts(
      submission.items.map((item) => item.productId),
    );
    const { lines, invoiceTotal, warnings } = priceItems(
      submission.items,
      products,
    );
    try {
      await invoiceWriter.assertStock(
        lines.map((line) => ({
          productId: line.productId,
          productQuantity: line.quantity,
        })),
      );
    } catch (error) {
      if (!isStockError(error)) throw error;
      if (stockBlocking)
        throw new TransitError(
          409,
          "STOCK_UNAVAILABLE",
          "Not enough CRM stock",
          error.errors,
        );
      warnings.push({
        field: "items",
        message: "Not enough CRM stock for this delivery",
      });
    }
    const warehouse = await activeWarehouse();
    // Checked before routing so no paid map call is made when it can't be priced.
    const card = await rateCardInForce();
    if (!card) priceSnapshot(null);
    const delivery = await resolveDelivery(
      {
        address: submission.customer.address,
        destination: submission.destination,
      },
      warehouse,
    );
    const pricing = priceSnapshot(card, delivery.distanceKm);
    return { lines, invoiceTotal, warnings, delivery, pricing };
  };

  // ---- Raw text and preview ------------------------------------------------------------

  const parseText = async (source) => parse(source);

  const preview = async (body) => {
    const submission = validateSubmission(body);
    const { lines, invoiceTotal, warnings, delivery, pricing } = await quote(
      submission,
      {
        stockBlocking: false,
      },
    );
    return {
      customer: submission.customer,
      items: lines,
      invoiceTotal,
      delivery,
      transport: {
        baseCharge: pricing.baseCharge,
        // Added only if the transporter later confirms a cash collection.
        cashIncentiveIfCashCollected: pricing.cashIncentive,
        tier: pricing.tier,
        rateCardName: pricing.rateCardName,
        currency: pricing.currency,
      },
      warnings,
      ready: true,
    };
  };

  // ---- Submission ---------------------------------------------------------------------

  const invoicePayload = (transit) => {
    const payload = toInvoicePayload({
      customer: {
        name: transit.customer.name,
        phone: transit.customer.phone,
        email: transit.customer.email,
        address: transit.delivery.address,
      },
      gst: false,
      gstDetails: {},
      items: transit.items.map((item) => ({
        productId: id(item.productId),
        productName: item.productName,
        productSlug: item.productSlug,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        serialNo: item.serialNo,
      })),
      // Payment is recorded later as collections; the invoice starts unpaid.
      paidStatus: "unpaid",
      paymentType: "",
    });
    return {
      ...payload,
      transport: { deliveredBy: transit.transporterName || "" },
      sourceTransitId: transit._id,
      transitDelivery: {
        address: transit.delivery.address,
        warehouse: {
          lat: transit.delivery.warehouse.lat,
          lng: transit.delivery.warehouse.lng,
          name: transit.delivery.warehouse.name,
        },
        destination: {
          lat: transit.delivery.destination.lat,
          lng: transit.delivery.destination.lng,
          source: transit.delivery.destination.source,
        },
        distanceKm: transit.delivery.distanceKm,
        provider: transit.delivery.provider,
        snapshotHash: transit.snapshotHash,
      },
    };
  };

  const sendInvoice = async (
    transit,
    invoice,
    actor,
    { retry = false } = {},
  ) => {
    const attempts = Number(transit.invoiceDelivery?.attempts || 0);
    const claimable = retry
      ? {
          $or: [
            { "invoiceDelivery.status": "failed" },
            {
              "invoiceDelivery.status": "sending",
              "invoiceDelivery.lastAttemptAt": {
                $lte: new Date(now().getTime() - STALE_SENDING_MS),
              },
            },
          ],
        }
      : { "invoiceDelivery.status": "pending" };
    const claimed = await store.updateTransit(
      transit._id,
      { ...claimable, "invoiceDelivery.attempts": attempts },
      {
        $set: {
          "invoiceDelivery.status": "sending",
          "invoiceDelivery.lastAttemptAt": now(),
        },
        $inc: { "invoiceDelivery.attempts": 1 },
      },
    );
    if (!claimed) {
      if (retry)
        throw new TransitError(
          409,
          "DELIVERY_NOT_RETRYABLE",
          "The invoice was already sent or is being sent",
        );
      return transit;
    }
    const attempt = claimed.invoiceDelivery.attempts;
    let set;
    try {
      const result = await notifier.deliverInvoice({
        invoice,
        // A new key per attempt: the notification log refuses to repeat a key.
        dedupePrefix: `transit:${id(transit._id)}:invoice:${attempt}`,
      });
      set =
        result?.success === true
          ? {
              "invoiceDelivery.status": "accepted",
              "invoiceDelivery.channel": result.channel || "whatsapp",
              "invoiceDelivery.acceptedAt": now(),
              "invoiceDelivery.lastErrorCode": null,
            }
          : {
              "invoiceDelivery.status": "failed",
              "invoiceDelivery.lastErrorCode": "DELIVERY_NOT_CONFIRMED",
            };
    } catch (error) {
      set = {
        "invoiceDelivery.status": "failed",
        "invoiceDelivery.lastErrorCode": String(
          error?.code || "DELIVERY_FAILED",
        ).slice(0, 80),
      };
    }
    const updated = await store.updateTransit(
      transit._id,
      { "invoiceDelivery.attempts": attempt },
      { $set: set },
    );
    await record(actor, "transit.invoice_delivery", transit._id, {
      attempt,
      status: set["invoiceDelivery.status"],
      errorCode: set["invoiceDelivery.lastErrorCode"] || null,
    });
    return updated || claimed;
  };

  const failSubmission = async (transit, error) => {
    await store.updateTransit(
      transit._id,
      { status: "processing" },
      {
        $set: {
          status: "failed",
          lockedUntil: null,
          lastError: {
            code: String(error?.code || "INVOICE_FAILED").slice(0, 80),
            message: String(error?.message || "").slice(0, 300),
            at: now(),
          },
        },
      },
    );
  };

  const finishSubmission = async (transit, actor) => {
    let invoice;
    try {
      invoice = await store.findInvoiceByTransit(transit._id);
      if (!invoice) {
        const payload = invoicePayload(transit);
        const { isValid, errors } = invoiceWriter.validate(payload);
        if (!isValid)
          throw new TransitError(
            400,
            "INVOICE_INVALID",
            "Invoice details are incomplete",
            errors,
          );
        try {
          ({ invoice } = await invoiceWriter.persist(payload));
        } catch (error) {
          // Unique sourceTransitId: a concurrent call created it first.
          if (error?.code !== 11000) throw error;
          invoice = await store.findInvoiceByTransit(transit._id);
          if (!invoice) throw error;
        }
      }
    } catch (error) {
      await failSubmission(transit, error);
      if (isStockError(error))
        throw new TransitError(
          409,
          "STOCK_UNAVAILABLE",
          "Not enough CRM stock",
          error.errors,
        );
      throw error instanceof TransitError
        ? error
        : new TransitError(
            500,
            "INVOICE_FAILED",
            "The invoice could not be created. Try again.",
          );
    }

    const invoiced = await store.updateTransit(
      transit._id,
      { status: "processing" },
      {
        $set: {
          status: "invoiced",
          invoiceId: invoice._id,
          invoiceNo: invoice.invoiceNo,
          lockedUntil: null,
        },
        $unset: { lastError: 1 },
        $push: { history: { at: now(), by: actor.id, action: "invoiced" } },
      },
    );
    const current = invoiced || (await store.findTransit(transit._id));
    try {
      await store.linkCustomer(invoice);
    } catch (error) {
      console.warn("Transit: customer link failed", {
        transitId: id(transit._id),
        message: error?.message,
      });
    }
    await record(actor, "transit.submitted", transit._id, {
      invoiceId: id(invoice._id),
      invoiceNo: invoice.invoiceNo,
      distanceKm: current.delivery.distanceKm,
      baseCharge: current.pricing.baseCharge,
    });
    if (!invoiced) return current;
    return sendInvoice(current, invoice, actor);
  };

  const submit = async (body, actor, idempotencyKey) => {
    const key = requireKey(idempotencyKey);
    const submission = validateSubmission(body);
    const hash = requestHash(submission);

    const resume = async (existing) => {
      if (existing.requestHash !== hash)
        throw new TransitError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was used for different details",
        );
      if (existing.status === "invoiced" || existing.status === "cancelled")
        return { transit: transitView(existing), replayed: true };
      const claimed = await store.updateTransit(
        existing._id,
        existing.status === "failed"
          ? { status: "failed" }
          : { status: "processing", lockedUntil: { $lte: now() } },
        {
          $set: {
            status: "processing",
            lockedUntil: new Date(now().getTime() + LOCK_MS),
          },
        },
      );
      if (!claimed)
        throw new TransitError(
          409,
          "SUBMISSION_IN_PROGRESS",
          "This delivery is already being submitted",
        );
      return {
        transit: transitView(await finishSubmission(claimed, actor)),
        replayed: true,
      };
    };

    const existing = await store.findTransitByKey(actor.id, key);
    if (existing) return resume(existing);

    const { lines, invoiceTotal, warnings, delivery, pricing } = await quote(
      submission,
      {
        stockBlocking: true,
      },
    );
    if (
      submission.expectedTransportCharge !== null &&
      submission.expectedTransportCharge !== pricing.baseCharge
    )
      throw new TransitError(
        409,
        "TRANSPORT_CHARGE_CHANGED",
        `The transport charge is now ₹${pricing.baseCharge}. Review it and submit again.`,
        { baseCharge: pricing.baseCharge, distanceKm: delivery.distanceKm },
      );

    const doc = {
      transporterId: actor.id,
      transporterName: actor.name || "",
      idempotencyKey: key,
      requestHash: hash,
      status: "processing",
      lockedUntil: new Date(now().getTime() + LOCK_MS),
      customer: {
        name: submission.customer.name,
        phone: submission.customer.phone,
        email: submission.customer.email,
      },
      items: lines,
      invoiceTotal,
      warnings,
      delivery,
      pricing,
      snapshotHash: snapshotHash(delivery, pricing),
      invoiceDelivery: { status: "pending", attempts: 0 },
      customerPayment: {
        status: "unpaid",
        amountDue: invoiceTotal,
        amountConfirmed: 0,
        amountPendingVerification: 0,
        collections: [],
        revision: 0,
      },
      payout: {
        ...payoutTotals({
          baseCharge: pricing.baseCharge,
          cashIncentive: 0,
          incentiveAwarded: false,
        }),
        incentiveAwarded: false,
        settlementStatus: "UNSETTLED",
      },
      corrections: [],
      history: [{ at: now(), by: actor.id, action: "submitted" }],
    };
    let created;
    try {
      created = await store.createTransit(doc);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const raced = await store.findTransitByKey(actor.id, key);
      if (!raced) throw error;
      return resume(raced);
    }
    return {
      transit: transitView(await finishSubmission(created, actor)),
      replayed: false,
    };
  };

  // ---- Reads ----------------------------------------------------------------------------

  const list = async (query = {}, actor) => {
    const { page, limit, skip } = pageOf(query);
    const filter = {};
    if (!canSeeAll(actor)) filter.transporterId = actor.id;
    else if (query.transporterId)
      filter.transporterId = requireId(query.transporterId);
    if (query.status) filter.status = String(query.status);
    if (query.settlementStatus)
      filter["payout.settlementStatus"] = String(
        query.settlementStatus,
      ).toUpperCase();
    if (query.paymentStatus)
      filter["customerPayment.status"] = String(query.paymentStatus);
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = dateOr(query.from);
      if (query.to) filter.createdAt.$lte = dateOr(query.to);
    }
    const { items, total } = await store.listTransits({ filter, skip, limit });
    return {
      items: items.map(transitView),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    };
  };

  const get = async (transitId, actor) =>
    transitView(await loadAccessible(transitId, actor));

  const retryInvoiceDelivery = async (transitId, actor) => {
    const transit = await loadAccessible(transitId, actor);
    if (transit.status !== "invoiced" || !transit.invoiceId)
      throw new TransitError(
        409,
        "NOT_INVOICED",
        "This delivery has no invoice to send",
      );
    const invoice = await store.findInvoiceById(transit.invoiceId);
    if (!invoice)
      throw new TransitError(
        409,
        "INVOICE_MISSING",
        "The invoice no longer exists",
      );
    return transitView(
      await sendInvoice(transit, invoice, actor, { retry: true }),
    );
  };

  // ---- Customer payments -------------------------------------------------------------

  const syncInvoicePayment = async (before, after, method) => {
    const previous = invoicePaidStatus(paymentSummary(before.customerPayment));
    const next = invoicePaidStatus(paymentSummary(after.customerPayment));
    if (previous === next || !after.invoiceId) return;
    await store.setInvoicePayment(after.invoiceId, {
      paidStatus: next,
      ...(method ? { paymentType: method } : {}),
    });
  };

  /** Applies a change to the collections with optimistic concurrency. */
  const updatePayment = async (transitId, change) => {
    for (let attempt = 0; attempt < COLLECTION_RETRIES; attempt += 1) {
      const transit = await store.findTransit(transitId);
      if (!transit) throw notFound();
      const result = change(transit);
      if (result.done) return { transit, ...result };
      const updated = await store.updateTransit(
        transitId,
        {
          "customerPayment.revision": transit.customerPayment.revision,
          status: "invoiced",
        },
        { ...result.update, $inc: { "customerPayment.revision": 1 } },
      );
      if (updated) {
        await syncInvoicePayment(transit, updated, result.method);
        return { transit: updated, ...result };
      }
    }
    throw new TransitError(
      409,
      "CONCURRENT_UPDATE",
      "The payment changed while saving. Try again.",
    );
  };

  const summarySet = (customerPayment, collections, exception) => {
    const summary = paymentSummary({
      ...customerPayment,
      collections,
      exception,
    });
    return {
      "customerPayment.status": summary.status,
      "customerPayment.amountConfirmed": summary.amountConfirmed,
      "customerPayment.amountPendingVerification":
        summary.amountPendingVerification,
      ...(summary.status === "paid" && customerPayment.status !== "paid"
        ? { "customerPayment.paidAt": now() }
        : {}),
    };
  };

  const recordCollection = async (transitId, body = {}, actor) => {
    const transit = await loadAccessible(transitId, actor);
    const isOwner = id(transit.transporterId) === actor.id;
    if (!isOwner && !actor.can("transit.manage"))
      throw new TransitError(
        403,
        "FORBIDDEN",
        "Only the delivering transporter can record a collection",
      );
    if (transit.status !== "invoiced")
      throw new TransitError(
        409,
        "NOT_COLLECTIBLE",
        "Payments can only be recorded on an invoiced delivery",
      );
    const collectionKey = requireKey(body.collectionKey, "collectionKey");
    const method = String(body.method || "").toLowerCase();
    if (!COLLECTION_METHODS.includes(method))
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        `method must be one of ${COLLECTION_METHODS.join(", ")}`,
      );
    const amount = money(body.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "amount must be more than 0",
      );
    const reference = text(body.reference, 120);
    if (method !== "cash" && !reference)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "A transaction reference is required for UPI, card and bank payments",
      );

    let incentiveAwarded = false;
    const result = await updatePayment(transit._id, (current) => {
      const payment = current.customerPayment;
      const duplicate = payment.collections.find(
        (c) => c.collectionKey === collectionKey,
      );
      if (duplicate) return { done: true, duplicate: true };
      const summary = paymentSummary(payment);
      if (
        summary.amountConfirmed + summary.amountPendingVerification + amount >
        payment.amountDue + 0.005
      )
        throw new TransitError(
          409,
          "AMOUNT_EXCEEDS_BALANCE",
          "This is more than the amount still due",
          {
            amountDue: payment.amountDue,
            amountConfirmed: summary.amountConfirmed,
            amountPendingVerification: summary.amountPendingVerification,
          },
        );
      const entry = {
        _id: store.newId(),
        collectionKey,
        amount,
        method,
        verification: verificationForMethod(method),
        reference,
        note: text(body.note, 300),
        collectedBy: actor.id,
        collectedAt: now(),
      };
      const collections = [...payment.collections, entry];
      const set = summarySet(payment, collections, payment.exception);
      // Incentive: confirmed cash collected by the delivering transporter,
      // once per transit, while the payout is still unsettled.
      const qualifies =
        method === "cash" &&
        id(current.transporterId) === actor.id &&
        !current.payout.incentiveAwarded &&
        current.payout.settlementStatus === "UNSETTLED";
      if (qualifies) {
        const totals = payoutTotals({
          baseCharge: current.payout.baseCharge,
          cashIncentive: current.pricing.cashIncentive,
          incentiveAwarded: true,
        });
        Object.assign(set, {
          "payout.incentiveAwarded": true,
          "payout.cashIncentive": totals.cashIncentive,
          "payout.totalPayable": totals.totalPayable,
          "payout.incentiveCollectionId": entry._id,
        });
      }
      incentiveAwarded = qualifies;
      return {
        method,
        update: {
          $set: set,
          $push: {
            "customerPayment.collections": entry,
            history: {
              at: now(),
              by: actor.id,
              action: `collection.${method}`,
            },
          },
        },
      };
    });
    if (!result.duplicate)
      await record(actor, "transit.collection_recorded", transit._id, {
        amount,
        method,
        incentiveAwarded,
      });
    return {
      transit: transitView(result.transit),
      duplicate: result.duplicate === true,
      incentiveAwarded,
    };
  };

  const reviewCollection = async (
    transitId,
    collectionId,
    body = {},
    actor,
  ) => {
    requireManage(actor);
    const decision = String(body.decision || "");
    if (!["verify", "reject"].includes(decision))
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        'decision must be "verify" or "reject"',
      );
    const note = text(body.note, 300);
    if (decision === "reject" && !note)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "A note is required to reject a payment",
      );
    await loadAccessible(transitId, actor);
    const result = await updatePayment(requireId(transitId), (current) => {
      const payment = current.customerPayment;
      const index = payment.collections.findIndex(
        (c) => id(c._id) === String(collectionId),
      );
      if (index < 0)
        throw new TransitError(404, "NOT_FOUND", "Collection not found");
      if (payment.collections[index].verification !== "transporter_reported")
        throw new TransitError(
          409,
          "ALREADY_REVIEWED",
          "Only reported UPI/card/bank payments need review",
        );
      const collections = payment.collections.map((c, i) =>
        i === index
          ? {
              ...c,
              verification:
                decision === "verify" ? "admin_verified" : "rejected",
            }
          : c,
      );
      return {
        method: payment.collections[index].method,
        update: {
          $set: {
            [`customerPayment.collections.${index}.verification`]:
              collections[index].verification,
            [`customerPayment.collections.${index}.verifiedBy`]: actor.id,
            [`customerPayment.collections.${index}.verifiedAt`]: now(),
            [`customerPayment.collections.${index}.verificationNote`]: note,
            ...summarySet(payment, collections, payment.exception),
          },
        },
      };
    });
    await record(
      actor,
      `transit.collection_${decision === "verify" ? "verified" : "rejected"}`,
      transitId,
      {
        collectionId: String(collectionId),
      },
    );
    return transitView(result.transit);
  };

  const approvePaymentException = async (transitId, body = {}, actor) => {
    requireManage(actor);
    const reason = text(body.reason, 500);
    if (reason.length < 5)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "A reason is required to mark an underpaid invoice as paid",
      );
    await loadAccessible(transitId, actor);
    const result = await updatePayment(requireId(transitId), (current) => {
      const exception = { approvedBy: actor.id, approvedAt: now(), reason };
      return {
        update: {
          $set: {
            "customerPayment.exception": exception,
            ...summarySet(
              current.customerPayment,
              current.customerPayment.collections,
              exception,
            ),
          },
        },
      };
    });
    await record(actor, "transit.payment_exception", transitId, { reason });
    return transitView(result.transit);
  };

  // ---- Corrections and cancellation -------------------------------------------------

  const correctDelivery = async (transitId, body = {}, actor) => {
    requireManage(actor);
    const reason = text(body.reason, 500);
    if (reason.length < 5)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "A reason is required for a correction",
      );
    const transit = await loadAccessible(transitId, actor);
    if (
      transit.status !== "invoiced" ||
      transit.payout.settlementStatus !== "UNSETTLED"
    )
      throw new TransitError(
        409,
        "NOT_CORRECTABLE",
        "Only invoiced, unsettled deliveries can be corrected",
      );
    const address = text(body.address, 500) || transit.delivery.address;
    const destination = body.destination ?? null;
    if (destination !== null && !validLatLng(destination))
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "destination is not valid",
      );
    // Same warehouse as the original route; only the destination is fixed.
    const delivery = await resolveDelivery(
      {
        address,
        destination: destination && {
          lat: Number(destination.lat),
          lng: Number(destination.lng),
        },
      },
      transit.delivery.warehouse,
    );
    const card =
      (transit.pricing.rateCardId &&
        (await store.findRateCard(transit.pricing.rateCardId))) ||
      (await rateCardInForce());
    const pricing = priceSnapshot(card, delivery.distanceKm);
    const totals = payoutTotals({
      baseCharge: pricing.baseCharge,
      cashIncentive: transit.payout.incentiveAwarded
        ? transit.pricing.cashIncentive
        : 0,
      incentiveAwarded: transit.payout.incentiveAwarded,
    });
    const hash = snapshotHash(delivery, pricing);
    const updated = await store.updateTransit(
      transit._id,
      {
        status: "invoiced",
        "payout.settlementStatus": "UNSETTLED",
        snapshotHash: transit.snapshotHash,
      },
      {
        $set: {
          delivery,
          pricing: { ...pricing, cashIncentive: transit.pricing.cashIncentive },
          snapshotHash: hash,
          "payout.baseCharge": totals.baseCharge,
          "payout.totalPayable": totals.totalPayable,
        },
        $push: {
          corrections: {
            at: now(),
            by: actor.id,
            reason,
            before: { delivery: transit.delivery, pricing: transit.pricing },
            after: { delivery, pricing },
          },
        },
      },
      { transitCorrection: true },
    );
    if (!updated)
      throw new TransitError(
        409,
        "CONCURRENT_UPDATE",
        "The delivery changed while correcting. Try again.",
      );
    if (transit.invoiceId)
      await store.correctInvoiceDelivery(transit.invoiceId, {
        address,
        transitDelivery: invoicePayload(updated).transitDelivery,
      });
    await record(actor, "transit.corrected", transit._id, {
      reason,
      distanceKmBefore: transit.delivery.distanceKm,
      distanceKmAfter: delivery.distanceKm,
      baseChargeBefore: transit.pricing.baseCharge,
      baseChargeAfter: pricing.baseCharge,
    });
    return transitView(updated);
  };

  const cancel = async (transitId, body = {}, actor) => {
    requireManage(actor);
    const reason = text(body.reason, 500);
    if (reason.length < 5)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "A reason is required to cancel",
      );
    const transit = await loadAccessible(transitId, actor);
    const updated = await store.updateTransit(
      transit._id,
      {
        status: { $in: ["invoiced", "failed"] },
        "payout.settlementStatus": "UNSETTLED",
      },
      {
        $set: {
          status: "cancelled",
          cancellation: { at: now(), by: actor.id, reason },
        },
        $push: {
          history: {
            at: now(),
            by: actor.id,
            action: "cancelled",
            note: reason,
          },
        },
      },
    );
    if (!updated)
      throw new TransitError(
        409,
        "NOT_CANCELLABLE",
        "Only unsettled deliveries can be cancelled",
      );
    await record(actor, "transit.cancelled", transit._id, {
      reason,
      invoiceId: id(transit.invoiceId),
    });
    return transitView(updated);
  };

  // ---- Warehouse, pricing, benchmarks ----------------------------------------------------

  const getWarehouse = async () => store.getActiveWarehouse();

  const setWarehouse = async (body = {}, actor) => {
    requireManage(actor);
    const name = text(body.name, 120);
    const address = text(body.address, 500);
    const location = {
      lat: Number(body.lat ?? body.location?.lat),
      lng: Number(body.lng ?? body.location?.lng),
    };
    if (!name || !address || !validLatLng(location))
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "name, address, lat and lng are required",
      );
    const previous = await store.getActiveWarehouse();
    const saved = await store.replaceActiveWarehouse(
      {
        name,
        address,
        location,
        isActive: true,
        createdBy: actor.id,
        updatedBy: actor.id,
        history: [
          {
            at: now(),
            by: actor.id,
            action: previous ? "replaced" : "created",
          },
        ],
      },
      actor.id,
    );
    await record(actor, "transit.warehouse_set", saved._id, {
      previousId: id(previous?._id),
      location,
    });
    return saved;
  };

  const listRateCards = async () => {
    const cards = await store.listRateCards();
    const current = currentRateCard(cards, now());
    return cards.map((card) => ({
      ...card,
      inForce: id(card._id) === id(current?._id),
    }));
  };

  const createRateCard = async (body = {}, actor) => {
    requireManage(actor);
    const input = validateRateCardInput(body, now());
    const active = await store.listActiveRateCards();
    if (
      active.some(
        (card) =>
          new Date(card.effectiveFrom).getTime() ===
          input.effectiveFrom.getTime(),
      )
    )
      throw new TransitError(
        409,
        "RATE_CARD_CONFLICT",
        "Another active rate card starts at the same time",
      );
    const card = await store.createRateCard({
      ...input,
      currency: "INR",
      status: "active",
      createdBy: actor.id,
      updatedBy: actor.id,
      history: [{ at: now(), by: actor.id, action: "created", after: input }],
    });
    await record(actor, "transit.rate_card_created", card._id, {
      tiers: input.tiers,
      cashIncentive: input.cashIncentive,
      effectiveFrom: input.effectiveFrom,
    });
    return card;
  };

  const updateRateCard = async (cardId, body = {}, actor) => {
    requireManage(actor);
    if (body.tiers !== undefined || body.cashIncentive !== undefined)
      throw new TransitError(
        400,
        "RATE_CARD_IMMUTABLE",
        "Prices can't be edited in place. Create a new rate card; it takes over from its effectiveFrom.",
      );
    const card = await store.findRateCard(requireId(cardId));
    if (!card) throw new TransitError(404, "NOT_FOUND", "Rate card not found");
    const set = {};
    if (body.status !== undefined) {
      if (!["active", "inactive"].includes(body.status))
        throw new TransitError(
          400,
          "VALIDATION_FAILED",
          'status must be "active" or "inactive"',
        );
      set.status = body.status;
    }
    if (body.effectiveTo !== undefined) {
      const effectiveTo = body.effectiveTo ? new Date(body.effectiveTo) : null;
      if (
        effectiveTo &&
        (Number.isNaN(effectiveTo.getTime()) ||
          effectiveTo <= new Date(card.effectiveFrom))
      )
        throw new TransitError(
          400,
          "VALIDATION_FAILED",
          "effectiveTo must be after effectiveFrom",
        );
      set.effectiveTo = effectiveTo;
    }
    if (body.name !== undefined) set.name = text(body.name, 120) || card.name;
    if (!Object.keys(set).length)
      throw new TransitError(400, "VALIDATION_FAILED", "Nothing to update");
    const before = Object.fromEntries(
      Object.keys(set).map((key) => [key, card[key] ?? null]),
    );
    const updated = await store.updateRateCard(card._id, {
      $set: { ...set, updatedBy: actor.id },
      $push: {
        history: {
          at: now(),
          by: actor.id,
          action: "updated",
          before,
          after: set,
        },
      },
    });
    await record(actor, "transit.rate_card_updated", card._id, {
      before,
      after: set,
    });
    return updated;
  };

  const benchmarkInput = (body, { partial }) => {
    const out = {};
    const errors = [];
    const number = (key, { required = false } = {}) => {
      if (body[key] === undefined) {
        if (required && !partial) errors.push(`${key} is required`);
        return;
      }
      const value = Number(body[key]);
      if (!Number.isFinite(value) || value < 0)
        errors.push(`${key} must be 0 or more`);
      else out[key] = money(value);
    };
    if (body.provider !== undefined || !partial) {
      if (!BENCHMARK_PROVIDERS.includes(body.provider))
        errors.push(
          `provider must be one of ${BENCHMARK_PROVIDERS.join(", ")}`,
        );
      else out.provider = body.provider;
    }
    if (body.vehicleType !== undefined || !partial) {
      const vehicleType = text(body.vehicleType, 60);
      if (!vehicleType) errors.push("vehicleType is required");
      else out.vehicleType = vehicleType;
    }
    number("baseFare", { required: true });
    number("perKm", { required: true });
    number("includedKm");
    number("perMinute");
    number("minimumFare");
    if (body.observedAt !== undefined || !partial) {
      const observedAt = new Date(body.observedAt);
      if (!body.observedAt || Number.isNaN(observedAt.getTime()))
        errors.push("observedAt (when the rate was checked) is required");
      else out.observedAt = observedAt;
    }
    if (body.label !== undefined) out.label = text(body.label, 120);
    if (body.sourceNote !== undefined)
      out.sourceNote = text(body.sourceNote, 500);
    if (body.isActive !== undefined) out.isActive = body.isActive === true;
    if (errors.length)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "Invalid benchmark",
        errors,
      );
    return out;
  };

  const listBenchmarks = async () => store.listBenchmarks();

  const createBenchmark = async (body = {}, actor) => {
    requireManage(actor);
    const input = benchmarkInput(body, { partial: false });
    const saved = await store.createBenchmark({
      ...input,
      isActive: input.isActive ?? true,
      createdBy: actor.id,
      updatedBy: actor.id,
      history: [{ at: now(), by: actor.id, action: "created", after: input }],
    });
    await record(actor, "transit.benchmark_created", saved._id, input);
    return saved;
  };

  const updateBenchmark = async (benchmarkId, body = {}, actor) => {
    requireManage(actor);
    const existing = await store.findBenchmark(requireId(benchmarkId));
    if (!existing)
      throw new TransitError(404, "NOT_FOUND", "Benchmark not found");
    const input = benchmarkInput(body, { partial: true });
    if (!Object.keys(input).length)
      throw new TransitError(400, "VALIDATION_FAILED", "Nothing to update");
    const before = Object.fromEntries(
      Object.keys(input).map((key) => [key, existing[key] ?? null]),
    );
    const updated = await store.updateBenchmark(existing._id, {
      $set: { ...input, updatedBy: actor.id },
      $push: {
        history: {
          at: now(),
          by: actor.id,
          action: "updated",
          before,
          after: input,
        },
      },
    });
    await record(actor, "transit.benchmark_updated", existing._id, {
      before,
      after: input,
    });
    return updated;
  };

  const compare = async (query = {}, actor) => {
    let distanceKm;
    let durationMinutes = null;
    let route = {};
    if (query.transitId) {
      const transit = await loadAccessible(query.transitId, actor);
      ({ distanceKm, durationMinutes } = transit.delivery);
      route = {
        origin: transit.delivery.warehouse,
        destination: transit.delivery.destination,
      };
    } else {
      distanceKm = Number(query.distanceKm);
      if (!Number.isFinite(distanceKm) || distanceKm < 0)
        throw new TransitError(
          400,
          "VALIDATION_FAILED",
          "transitId or distanceKm is required",
        );
      if (query.durationMinutes !== undefined)
        durationMinutes = Number(query.durationMinutes) || null;
    }
    return comparison.compare({
      distanceKm,
      durationMinutes,
      rateCard: await rateCardInForce(),
      benchmarks: await store.listBenchmarks({ activeOnly: true }),
      route,
    });
  };

  // ---- Settlement ---------------------------------------------------------------------

  const skipReason = (transit, actor) => {
    if (!transit) return "not_found";
    if (id(transit.transporterId) === actor.id) return "own_payout";
    if (transit.payout.settlementStatus === "SETTLED") return "already_settled";
    if (transit.status !== "invoiced") return `status_${transit.status}`;
    return "changed_concurrently";
  };

  const settle = async (body = {}, actor, idempotencyKey) => {
    if (!actor.can("transit.settle"))
      throw new TransitError(403, "FORBIDDEN", "Insufficient permission");
    const key = requireKey(idempotencyKey);
    const existing = await store.findSettlementBatchByKey(key);
    if (existing) return { batch: existing, replayed: true };
    const ids = [
      ...new Set(
        (Array.isArray(body.transitIds) ? body.transitIds : []).map(String),
      ),
    ];
    if (
      !ids.length ||
      ids.length > MAX_SETTLE ||
      !ids.every((value) => ID_PATTERN.test(value))
    )
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        `transitIds must list 1 to ${MAX_SETTLE} transit ids`,
      );
    const paymentReference = text(body.paymentReference, 120);
    if (!paymentReference)
      throw new TransitError(
        400,
        "VALIDATION_FAILED",
        "paymentReference (the payout transaction reference) is required",
      );

    let batch;
    try {
      batch = await store.createSettlementBatch({
        idempotencyKey: key,
        status: "processing",
        paymentReference,
        note: text(body.note, 500),
        requestedTransitIds: ids,
        settledBy: actor.id,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return {
        batch: await store.findSettlementBatchByKey(key),
        replayed: true,
      };
    }

    const settledAt = now();
    // One conditional update: a transit is settled by exactly one batch even
    // when two admins settle at the same time.
    await store.settleTransits(
      {
        _id: { $in: ids },
        status: "invoiced",
        "payout.settlementStatus": "UNSETTLED",
        transporterId: { $ne: actor.id },
      },
      {
        $set: {
          "payout.settlementStatus": "SETTLED",
          "payout.settledAt": settledAt,
          "payout.settledBy": actor.id,
          "payout.settlementReference": paymentReference,
          "payout.settlementBatchId": batch._id,
        },
      },
    );
    const settled = await store.findTransits({
      "payout.settlementBatchId": batch._id,
    });
    const settledIds = new Set(settled.map((t) => id(t._id)));
    const others = await store.findTransits({
      _id: { $in: ids.filter((v) => !settledIds.has(v)) },
    });
    const skipped = ids
      .filter((value) => !settledIds.has(value))
      .map((value) => ({
        transitId: value,
        reason: skipReason(
          others.find((t) => id(t._id) === value),
          actor,
        ),
      }));
    const byTransporter = new Map();
    const totals = {
      count: 0,
      baseCharge: 0,
      cashIncentive: 0,
      totalPayable: 0,
    };
    for (const transit of settled) {
      totals.count += 1;
      totals.baseCharge = money(totals.baseCharge + transit.payout.baseCharge);
      totals.cashIncentive = money(
        totals.cashIncentive + transit.payout.cashIncentive,
      );
      totals.totalPayable = money(
        totals.totalPayable + transit.payout.totalPayable,
      );
      const entry = byTransporter.get(id(transit.transporterId)) || {
        transporterId: id(transit.transporterId),
        count: 0,
        totalPayable: 0,
      };
      entry.count += 1;
      entry.totalPayable = money(
        entry.totalPayable + transit.payout.totalPayable,
      );
      byTransporter.set(entry.transporterId, entry);
    }
    const finished = await store.updateSettlementBatch(batch._id, {
      $set: {
        status: settled.length ? "done" : "empty",
        settledTransitIds: [...settledIds],
        skipped,
        totals,
        byTransporter: [...byTransporter.values()],
        settledAt,
      },
    });
    await record(actor, "transit.settled", batch._id, {
      paymentReference,
      count: totals.count,
      totalPayable: totals.totalPayable,
      skipped: skipped.length,
    });
    if (!settled.length)
      throw new TransitError(
        409,
        "NOTHING_TO_SETTLE",
        "None of these deliveries can be settled",
        {
          batchId: id(batch._id),
          skipped,
        },
      );
    return { batch: finished, replayed: false };
  };

  const listSettlementBatches = async (query = {}) => {
    const { page, limit, skip } = pageOf(query);
    const { items, total } = await store.listSettlementBatches({ skip, limit });
    return {
      items,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1,
    };
  };

  // ---- Payouts and reports --------------------------------------------------------------

  const payoutSummary = async (actor) => {
    const transits = await store.findTransits({
      transporterId: actor.id,
      status: "invoiced",
    });
    const sum = (list) =>
      money(list.reduce((total, t) => total + t.payout.totalPayable, 0));
    const unsettled = transits.filter(
      (t) => t.payout.settlementStatus === "UNSETTLED",
    );
    const settled = transits.filter(
      (t) => t.payout.settlementStatus === "SETTLED",
    );
    return {
      unsettled: { count: unsettled.length, totalPayable: sum(unsettled) },
      settled: { count: settled.length, totalPayable: sum(settled) },
    };
  };

  const report = async (query = {}) => {
    const to = dateOr(query.to, now());
    const from = dateOr(
      query.from,
      new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000),
    );
    const filter = { createdAt: { $gte: from, $lte: to } };
    if (query.transporterId)
      filter.transporterId = requireId(query.transporterId);
    const all = await store.findTransits(filter, { limit: REPORT_LIMIT + 1 });
    const truncated = all.length > REPORT_LIMIT;
    const rows = all.slice(0, REPORT_LIMIT);
    const live = rows.filter((t) => t.status === "invoiced");
    const blank = () => ({
      deliveries: 0,
      distanceKm: 0,
      revenue: 0,
      transportBase: 0,
      cashIncentives: 0,
      transportPayable: 0,
      settledPayable: 0,
      unsettledPayable: 0,
      customerDue: 0,
      customerConfirmed: 0,
      customerOutstanding: 0,
      customerPaidCount: 0,
      customerUnpaidCount: 0,
      invoiceDeliveryFailed: 0,
    });
    const add = (bucket, t) => {
      bucket.deliveries += 1;
      bucket.distanceKm = money(bucket.distanceKm + t.delivery.distanceKm);
      bucket.revenue = money(bucket.revenue + t.invoiceTotal);
      bucket.transportBase = money(bucket.transportBase + t.payout.baseCharge);
      bucket.cashIncentives = money(
        bucket.cashIncentives + t.payout.cashIncentive,
      );
      bucket.transportPayable = money(
        bucket.transportPayable + t.payout.totalPayable,
      );
      if (t.payout.settlementStatus === "SETTLED")
        bucket.settledPayable = money(
          bucket.settledPayable + t.payout.totalPayable,
        );
      else
        bucket.unsettledPayable = money(
          bucket.unsettledPayable + t.payout.totalPayable,
        );
      const summary = paymentSummary(t.customerPayment);
      bucket.customerDue = money(
        bucket.customerDue + t.customerPayment.amountDue,
      );
      bucket.customerConfirmed = money(
        bucket.customerConfirmed + summary.amountConfirmed,
      );
      bucket.customerOutstanding = money(
        bucket.customerOutstanding + summary.balance,
      );
      if (t.customerPayment.status === "paid") bucket.customerPaidCount += 1;
      else bucket.customerUnpaidCount += 1;
      if (t.invoiceDelivery?.status === "failed")
        bucket.invoiceDeliveryFailed += 1;
    };
    const finish = (bucket) => ({
      ...bucket,
      // Product revenue minus transport cost. Product cost is not included,
      // and invoice revenue itself is never changed by transport.
      contributionAfterTransport: money(
        bucket.revenue - bucket.transportPayable,
      ),
      transportShareOfRevenue: bucket.revenue
        ? Math.round((bucket.transportPayable / bucket.revenue) * 10000) / 100
        : 0,
    });
    const totals = blank();
    const byTransporter = new Map();
    for (const t of live) {
      add(totals, t);
      const key = id(t.transporterId);
      if (!byTransporter.has(key))
        byTransporter.set(key, {
          transporterId: key,
          transporterName: t.transporterName,
          ...blank(),
        });
      add(byTransporter.get(key), t);
    }
    return {
      from,
      to,
      truncated,
      cancelled: rows.filter((t) => t.status === "cancelled").length,
      failedSubmissions: rows.filter((t) => t.status === "failed").length,
      totals: finish(totals),
      byTransporter: [...byTransporter.values()].map(finish),
    };
  };

  return {
    parseText,
    preview,
    submit,
    list,
    get,
    retryInvoiceDelivery,
    recordCollection,
    reviewCollection,
    approvePaymentException,
    correctDelivery,
    cancel,
    getWarehouse,
    setWarehouse,
    listRateCards,
    createRateCard,
    updateRateCard,
    listBenchmarks,
    createBenchmark,
    updateBenchmark,
    compare,
    settle,
    listSettlementBatches,
    payoutSummary,
    report,
  };
};
