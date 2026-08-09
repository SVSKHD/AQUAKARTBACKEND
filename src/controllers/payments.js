import crypto from "crypto";
import CheckoutSession from "../models/checkoutSession.js";
import PaymentAttempt from "../models/paymentAttempt.js";
import PaymentGateway from "../models/paymentGateway.js";
import Order from "../models/orders.js";
import Coupon from "../models/coupon.js";
import CouponRedemption from "../models/couponRedemption.js";
import {
  createPhonePePayment,
  verifyPhonePePayment,
} from "../services/gateways/phonepe.js";
import { writeAudit } from "../services/audit.js";
import { qualifyReferralForPaidOrder } from "../services/referrals.js";

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
  const legacyPhonePeConfigured = Boolean(
    process.env.PHONEPE_MERCHANTID && process.env.PHONEPE_KEY,
  );
  const data = configured.length
    ? configured
    : legacyPhonePeConfigured
      ? [{ key: "phonepe", displayName: "PhonePe", methods: ["upi", "card"] }]
      : [];
  return res.json({ success: true, data });
};

const createOrderFromSession = async (session, userId, address) =>
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
      (!gatewayConfig &&
        key === "phonepe" &&
        (!process.env.PHONEPE_MERCHANTID || !process.env.PHONEPE_KEY))
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
    const order = await createOrderFromSession(session, req.user._id, address);
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
  }
  return attempt;
};

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
    const verification = await verifyPhonePePayment(
      attempt.merchantTransactionId,
    );
    await finalize(attempt, verification, "phonepe-webhook-verified");
    return res.json({ success: true });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
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
