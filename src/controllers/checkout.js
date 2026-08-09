import CheckoutSession from "../models/checkoutSession.js";
import Order from "../models/orders.js";
import Coupon from "../models/coupon.js";
import CouponRedemption from "../models/couponRedemption.js";
import { createCheckoutSession } from "../services/checkout.js";

const sessionView = (session) => ({
  id: session._id,
  items: session.items,
  coupon: session.couponCode
    ? { code: session.couponCode, status: "valid" }
    : null,
  subtotal: session.subtotal,
  discount: session.discount,
  rewardCredit: session.rewardCredit,
  deliveryCharge: session.deliveryCharge,
  tax: session.tax,
  payableAmount: session.payableAmount,
  currency: session.currency,
  expiresAt: session.expiresAt,
});

export const quote = async (req, res) => {
  try {
    const session = await createCheckoutSession({
      userId: req.user._id,
      cart: req.body.cart,
      couponCode: req.body.couponCode,
    });
    return res.status(201).json({ success: true, data: sessionView(session) });
  } catch (error) {
    return res
      .status(error.status || 400)
      .json({ success: false, message: error.message });
  }
};

export const createCodOrder = async (req, res) => {
  const session = await CheckoutSession.findOne({
    _id: req.body.checkoutSessionId,
    userId: req.user._id,
    status: "open",
    expiresAt: { $gt: new Date() },
  });
  if (!session)
    return res
      .status(409)
      .json({
        success: false,
        message: "Checkout session is invalid or expired",
      });
  const address = req.body.shippingAddress;
  if (
    !address ||
    !address.street ||
    !address.city ||
    !address.state ||
    !address.postalCode
  )
    return res
      .status(400)
      .json({
        success: false,
        message: "Complete shipping address is required",
      });
  const order = await Order.create({
    user: req.user._id,
    orderId: `AQOD-${Date.now()}`,
    transactionId: `AQTR-COD-${Date.now()}`,
    orderType: "Cash On Delivery",
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
    paymentMethod: "Cash On Delivery",
    paymentStatus: "Pending",
    currency: session.currency,
    billingAddress: req.body.billingAddress || address,
    shippingAddress: address,
    shippingMethod: "Standard",
    estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    orderStatus: "Processing",
    offerApplied: Boolean(session.couponCode),
    offerAppliedDetails: session.couponCode
      ? { code: session.couponCode }
      : undefined,
  });
  session.status = "consumed";
  await session.save();
  if (session.couponId) {
    await Promise.all([
      Coupon.updateOne({ _id: session.couponId }, { $inc: { usageCount: 1 } }),
      CouponRedemption.create({
        couponId: session.couponId,
        code: session.couponCode,
        userId: req.user._id,
        orderId: order._id,
        checkoutSessionId: session._id,
        subtotal: session.subtotal,
        discount: session.discount,
        status: "redeemed",
        redeemedAt: new Date(),
      }),
    ]);
  }
  return res.status(201).json({ success: true, data: order });
};
