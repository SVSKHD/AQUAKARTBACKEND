import crypto from "crypto";
import CheckoutSession from "../models/checkoutSession.js";
import PaymentAttempt from "../models/paymentAttempt.js";
import PaymentGateway from "../models/paymentGateway.js";
import Order from "../models/orders.js";
import Coupon from "../models/coupon.js";
import CouponRedemption from "../models/couponRedemption.js";
import {
  createPhonePePayment,
  isPhonePeConfigured,
  isPhonePeWebhookAuthorized,
  verifyPhonePePayment,
} from "../services/gateways/phonepe.js";
import { reconcileLegacyOrder } from "./phonepeGateway.js";
import { writeAudit } from "../services/audit.js";
import { installationFrom } from "../services/checkout.js";
import { qualifyReferralForPaidOrder } from "../services/referrals.js";
import { offlinePayments } from "../services/offlinePayments/index.js";
import AquaEcomUser from "../models/user.js";
import {
  fireAndForget,
  notifyStorefrontOrderPaid,
} from "../services/notifications/paymentNotifications.js";

// Attempts from admin-created payment links (source CRM_OFFLINE) have no
// order or checkout session; their verification is handled by the offline
// payment service. Storefront (ECOM) attempts keep using finalize() below.
const isOffline = (attempt) => attempt?.source === "CRM_OFFLINE";
const plainAttempt = (attempt) =>
  typeof attempt?.toObject === "function" ? attempt.toObject() : attempt;

const gatewayHandlers = {
  phonepe: { create: createPhonePePayment, verify: verifyPhonePePayment },
};
const merchantId = () =>
  `AQTR-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

export const methods = async (_req, res) => {
  const configured = await PaymentGateway.find({ enabled: true })
    .sort({ priority: 1 })
    .select("key displayName methods")
    .lean();
  const legacyPhonePeConfigured = isPhonePeConfigured();
  const data = configured.length
    ? configured
    : legacyPhonePeConfigured
      ? [{ key: "phonepe", displayName: "PhonePe", methods: ["upi", "card"] }]
      : [];
  return res.json({ success: true, data });
};

const createOrderFromSession = async (session, userId, address, installation) =>
  Order.create({
    user: userId,
    orderId: `AQOD-${Date.now()}`,
    transactionId: merchantId(),
    orderType: "Payment Method Gateway",
    items: session.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      price: item.unitPrice,
      quantity: item.quantity,
    })),
    totalAmount: session.payableAmount,
    discounts: session.discount,
    taxes: session.tax,
    shippingCost: session.deliveryCharge,
    paymentMethod: "Gateway",
    paymentStatus: "Processing",
    currency: session.currency,
    billingAddress: address,
    shippingAddress: address,
    shippingMethod: "Standard",
    estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    installation: installationFrom(installation),
    orderStatus: "Processing",
    offerApplied: Boolean(session.couponCode),
    offerAppliedDetails: session.couponCode
      ? { code: session.couponCode }
      : undefined,
  });

export const createPayment = async (req, res) => {
  try {
    const key = String(req.body.gateway || "phonepe").toLowerCase();
    const handler = gatewayHandlers[key];
    if (!handler)
      return res
        .status(400)
        .json({ success: false, message: "Unsupported payment gateway" });
    const gatewayConfig = await PaymentGateway.findOne({ key }).lean();
    if (
      (gatewayConfig && !gatewayConfig.enabled) ||
      (!gatewayConfig && key === "phonepe" && !isPhonePeConfigured())
    ) {
      return res
        .status(503)
        .json({ success: false, message: "Payment gateway is disabled" });
    }
    const idempotencyKey = String(
      req.header("Idempotency-Key") || req.body.idempotencyKey || "",
    ).trim();
    if (!idempotencyKey)
      return res
        .status(400)
        .json({ success: false, message: "Idempotency-Key is required" });
    const existing = await PaymentAttempt.findOne({
      idempotencyKey,
      userId: req.user._id,
    });
    if (existing) return res.json({ success: true, data: existing });
    const session = await CheckoutSession.findOne({
      _id: req.body.checkoutSessionId,
      userId: req.user._id,
      status: "open",
      expiresAt: { $gt: new Date() },
    });
    if (!session)
      return res.status(409).json({
        success: false,
        message: "Checkout session is invalid or expired",
      });
    const address = req.body.shippingAddress;
    if (
      !address?.street ||
      !address?.city ||
      !address?.state ||
      !address?.postalCode
    )
      return res.status(400).json({
        success: false,
        message: "Complete shipping address is required",
      });
    const order = await createOrderFromSession(
      session,
      req.user._id,
      address,
      req.body.installation,
    );
    const transactionId = order.transactionId;
    const attempt = await PaymentAttempt.create({
      checkoutSessionId: session._id,
      orderId: order._id,
      userId: req.user._id,
      gateway: key,
      idempotencyKey,
      merchantTransactionId: transactionId,
      amount: session.payableAmount,
      currency: session.currency,
      statusHistory: [{ status: "created", source: "api" }],
    });
    const result = await handler.create({
      transactionId,
      userId: req.user._id,
      amount: session.payableAmount,
      phone: req.user.phone,
    });
    attempt.redirectUrl = result.redirectUrl;
    attempt.gatewayTransactionId = result.transactionId;
    attempt.gatewayResponse = result.raw;
    attempt.status = "pending";
    attempt.statusHistory.push({ status: "pending", source: "gateway-create" });
    await attempt.save();
    session.status = "consumed";
    await session.save();
    return res.status(201).json({
      success: true,
      data: {
        id: attempt._id,
        orderId: order._id,
        status: attempt.status,
        redirectUrl: attempt.redirectUrl,
        amount: attempt.amount,
        currency: attempt.currency,
      },
    });
  } catch (error) {
    return res
      .status(error.status || 502)
      .json({ success: false, message: error.message });
  }
};

export const getPayment = async (req, res) => {
  const attempt = await PaymentAttempt.findOne({
    _id: req.params.id,
    userId: req.user._id,
  }).select(
    "orderId gateway amount currency status redirectUrl createdAt updatedAt",
  );
  return attempt
    ? res.json({ success: true, data: attempt })
    : res.status(404).json({ success: false, message: "Payment not found" });
};

const finalize = async (attempt, verification, source) => {
  if (
    verification.amount &&
    Number(verification.amount.toFixed(2)) !== Number(attempt.amount.toFixed(2))
  )
    throw new Error("Gateway amount mismatch");
  const newlyPaid = verification.status === "paid" && attempt.status !== "paid";
  attempt.status = verification.status;
  attempt.gatewayResponse = verification.raw;
  attempt.statusHistory.push({ status: verification.status, source });
  if (verification.status === "paid") attempt.verifiedAt = new Date();
  await attempt.save();
  await Order.updateOne(
    { _id: attempt.orderId },
    {
      paymentStatus:
        verification.status === "paid"
          ? "Paid"
          : verification.status === "pending"
            ? "Processing"
            : "Failed",
      paymentGatewayDetails: verification.raw,
    },
  );
  if (verification.status === "paid") {
    const session = await CheckoutSession.findById(attempt.checkoutSessionId);
    if (
      session?.couponId &&
      !(await CouponRedemption.exists({
        orderId: attempt.orderId,
        status: "redeemed",
      }))
    ) {
      await Promise.all([
        Coupon.updateOne(
          { _id: session.couponId },
          { $inc: { usageCount: 1 } },
        ),
        CouponRedemption.create({
          couponId: session.couponId,
          code: session.couponCode,
          userId: attempt.userId,
          orderId: attempt.orderId,
          checkoutSessionId: session._id,
          subtotal: session.subtotal,
          discount: session.discount,
          status: "redeemed",
          redeemedAt: new Date(),
        }),
      ]);
    }
    await qualifyReferralForPaidOrder({
      userId: attempt.userId,
      orderId: attempt.orderId,
      amount: attempt.amount,
    });
    // Admin alert + order confirmation; deduplicated, never blocks.
    if (newlyPaid)
      fireAndForget("Storefront order paid", async () => {
        const order = await Order.findById(attempt.orderId).lean();
        if (!order) return;
        const user = await AquaEcomUser.findById(order.user)
          .select("firstName lastName phone alternatePhone")
          .lean();
        await notifyStorefrontOrderPaid({ order, user });
      });
  }
  return attempt;
};

// A webhook only says "look at this payment": the status always comes from
// PhonePe's status API with our credentials, never from the request body.
const settleAttempt = async (attempt, source) => {
  const verification = await verifyPhonePePayment(
    attempt.merchantTransactionId,
  );
  if (isOffline(attempt))
    return offlinePayments.processVerification(
      plainAttempt(attempt),
      verification,
      source,
    );
  return finalize(attempt, verification, source);
};

// v1: PhonePe calls the callbackUrl set on each payment.
export const phonePeWebhook = async (req, res) => {
  try {
    const attempt = await PaymentAttempt.findOne({
      merchantTransactionId: req.params.transactionId,
      gateway: "phonepe",
    });
    if (!attempt)
      return res
        .status(404)
        .json({ success: false, message: "Payment not found" });
    await settleAttempt(attempt, "phonepe-webhook-verified");
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

const MERCHANT_ORDER_ID = /^[A-Za-z0-9_-]{1,63}$/;
let warnedUnauthenticatedWebhook = false;

// v2: one webhook for every payment, set up on the PhonePe Business
// dashboard (events checkout.order.completed / checkout.order.failed) and
// pointed at POST /v1/webhooks/payments/phonepe. Covers checkout and payment
// link attempts, and legacy /checkout orders (no PaymentAttempt).
export const phonePeWebhookV2 = async (req, res) => {
  const authorized = isPhonePeWebhookAuthorized(req.get("authorization"));
  if (authorized === false)
    return res.status(401).json({ success: false, message: "Unauthorized" });
  if (authorized === null && !warnedUnauthenticatedWebhook) {
    warnedUnauthenticatedWebhook = true;
    console.warn(
      "PhonePe webhook credentials are not set (PHONEPE_WEBHOOK_USERNAME/PASSWORD); relying on the status API check only.",
    );
  }
  const merchantOrderId = String(req.body?.payload?.merchantOrderId || "");
  if (!MERCHANT_ORDER_ID.test(merchantOrderId))
    return res
      .status(400)
      .json({ success: false, message: "merchantOrderId is missing" });
  try {
    const attempt = await PaymentAttempt.findOne({
      merchantTransactionId: merchantOrderId,
      gateway: "phonepe",
    });
    if (attempt) {
      await settleAttempt(attempt, "phonepe-webhook-verified");
      return res.json({ success: true });
    }
    if (await Order.exists({ transactionId: merchantOrderId })) {
      const { status } = await reconcileLegacyOrder(merchantOrderId);
      // 5xx asks PhonePe to retry; anything else is final for this event.
      return res.status(status >= 500 ? status : 200).json({
        success: status < 400,
      });
    }
    // Not ours to settle (or already removed): acknowledge so it isn't retried.
    return res.json({ success: true, ignored: true });
  } catch (error) {
    console.error("PhonePe webhook failed:", error?.message || error);
    return res.status(500).json({ success: false });
  }
};

export const listAdminPayments = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const [data, total] = await Promise.all([
    PaymentAttempt.find({})
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PaymentAttempt.countDocuments(),
  ]);
  return res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};
export const reconcile = async (req, res) => {
  const attempt = await PaymentAttempt.findById(req.params.id);
  if (!attempt || !gatewayHandlers[attempt.gateway])
    return res
      .status(404)
      .json({ success: false, message: "Payment not found" });
  const before = attempt.toObject();
  if (isOffline(attempt)) {
    try {
      const verification = await gatewayHandlers[attempt.gateway].verify(
        attempt.merchantTransactionId,
      );
      let updated = await offlinePayments.processVerification(
        before,
        verification,
        "admin-reconcile",
      );
      // Paid but the invoice is missing (e.g. stock was short): retry it.
      if (updated?.status === "paid")
        await offlinePayments.retryConversion(updated);
      updated = await PaymentAttempt.findById(attempt._id).lean();
      await writeAudit({
        req,
        action: "payment.reconcile",
        resourceType: "payment",
        resourceId: attempt._id,
        before,
        after: updated,
      });
      return res.json({ success: true, data: updated });
    } catch (error) {
      return res
        .status(error.status || 400)
        .json({ success: false, code: error.code, message: error.message });
    }
  }
  const updated = await finalize(
    attempt,
    await gatewayHandlers[attempt.gateway].verify(
      attempt.merchantTransactionId,
    ),
    "admin-reconcile",
  );
  await writeAudit({
    req,
    action: "payment.reconcile",
    resourceType: "payment",
    resourceId: attempt._id,
    before,
    after: updated,
  });
  return res.json({ success: true, data: updated });
};

export const listGateways = async (_req, res) =>
  res.json({
    success: true,
    data: await PaymentGateway.find({}).sort({ priority: 1 }).lean(),
  });
export const upsertGateway = async (req, res) => {
  const before = await PaymentGateway.findOne({ key: req.params.key }).lean();
  const publicConfig = {
    mode: req.body.config?.mode === "sandbox" ? "sandbox" : "production",
    merchantDisplayName: String(
      req.body.config?.merchantDisplayName || "Aquakart",
    ).slice(0, 100),
  };
  const update = {
    displayName: req.body.displayName,
    enabled: Boolean(req.body.enabled),
    priority: Number(req.body.priority || 100),
    methods: req.body.methods || [],
    // Credentials remain in environment/secret storage.
    config: publicConfig,
    updatedBy: req.user._id,
  };
  const gateway = await PaymentGateway.findOneAndUpdate(
    { key: req.params.key.toLowerCase() },
    update,
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  );
  await writeAudit({
    req,
    action: "gateway.update",
    resourceType: "payment-gateway",
    resourceId: gateway._id,
    before,
    after: gateway,
  });
  return res.json({ success: true, data: gateway });
};
