import mongoose from "mongoose";
import Product from "../models/product.js";
import CheckoutSession from "../models/checkoutSession.js";
import { validateCoupon } from "./coupons.js";

const money = (value) =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export const buildCheckout = async ({ userId, cart, couponCode }) => {
  if (!Array.isArray(cart) || !cart.length)
    throw Object.assign(new Error("Cart must contain at least one item"), {
      status: 400,
    });
  const normalized = cart.map((item) => ({
    productId: String(item.productId || ""),
    quantity: Number(item.quantity),
  }));
  if (
    normalized.some(
      (item) =>
        !mongoose.Types.ObjectId.isValid(item.productId) ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 5,
    )
  )
    throw Object.assign(
      new Error("Cart contains an invalid product or quantity"),
      { status: 400 },
    );
  const uniqueIds = [...new Set(normalized.map((item) => item.productId))];
  if (uniqueIds.length !== normalized.length)
    throw Object.assign(new Error("Duplicate cart products are not allowed"), {
      status: 400,
    });
  const products = await Product.find({ _id: { $in: uniqueIds } }).lean();
  if (products.length !== uniqueIds.length)
    throw Object.assign(new Error("One or more products are unavailable"), {
      status: 409,
    });
  const byId = new Map(
    products.map((product) => [String(product._id), product]),
  );
  const items = normalized.map((item) => {
    const product = byId.get(item.productId);
    if (product.stock < item.quantity)
      throw Object.assign(
        new Error(`${product.title} does not have enough stock`),
        { status: 409 },
      );
    const unitPrice =
      product.discountPriceStatus && Number(product.discountPrice) >= 0
        ? Number(product.discountPrice)
        : Number(product.price);
    return {
      productId: product._id,
      name: product.title,
      category: product.category,
      unitPrice: money(unitPrice),
      quantity: item.quantity,
      lineTotal: money(unitPrice * item.quantity),
    };
  });
  const subtotal = money(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const { coupon, discount } = await validateCoupon({
    code: couponCode,
    userId,
    subtotal,
    items,
  });
  const deliveryCharge = money(
    Number(process.env.STANDARD_DELIVERY_CHARGE || 50),
  );
  const tax = 0;
  const payableAmount = money(
    Math.max(0, subtotal - discount + deliveryCharge + tax),
  );
  return {
    items,
    coupon,
    subtotal,
    discount: money(discount),
    deliveryCharge,
    tax,
    payableAmount,
    currency: "INR",
  };
};

export const createCheckoutSession = async ({ userId, cart, couponCode }) => {
  const quote = await buildCheckout({ userId, cart, couponCode });
  return CheckoutSession.create({
    userId,
    items: quote.items,
    couponId: quote.coupon?._id,
    couponCode: quote.coupon?.code,
    subtotal: quote.subtotal,
    discount: quote.discount,
    deliveryCharge: quote.deliveryCharge,
    tax: quote.tax,
    payableAmount: quote.payableAmount,
    currency: quote.currency,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
};
