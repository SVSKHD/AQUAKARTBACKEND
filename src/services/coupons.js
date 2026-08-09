import Coupon from "../models/coupon.js";
import CouponRedemption from "../models/couponRedemption.js";
import AquaOrder from "../models/orders.js";

export const calculateCouponDiscount = (coupon, subtotal) => {
  const raw =
    coupon.discountType === "fixed"
      ? coupon.discountValue
      : subtotal * (coupon.discountValue / 100);
  return Math.max(0, Math.min(raw, coupon.maxDiscount ?? raw, subtotal));
};

export const validateCoupon = async ({
  code,
  userId,
  subtotal,
  items,
  now = new Date(),
}) => {
  if (!code) return { coupon: null, discount: 0 };
  const coupon = await Coupon.findOne({
    code: String(code).trim().toUpperCase(),
  });
  if (!coupon || coupon.status !== "active")
    throw Object.assign(new Error("Coupon is not active"), { status: 400 });
  if (coupon.startsAt > now || coupon.endsAt < now)
    throw Object.assign(new Error("Coupon is outside its validity period"), {
      status: 400,
    });
  if (subtotal < coupon.minimumOrder)
    throw Object.assign(new Error(`Minimum order is ${coupon.minimumOrder}`), {
      status: 400,
    });
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit)
    throw Object.assign(new Error("Coupon usage limit reached"), {
      status: 409,
    });
  if (
    coupon.userIds.length &&
    !coupon.userIds.some((id) => String(id) === String(userId))
  )
    throw Object.assign(new Error("Coupon is not available for this account"), {
      status: 403,
    });
  if (
    coupon.productIds.length &&
    !items.some((item) =>
      coupon.productIds.some((id) => String(id) === String(item.productId)),
    )
  )
    throw Object.assign(new Error("Coupon does not apply to these products"), {
      status: 400,
    });
  if (
    coupon.categoryIds.length &&
    !items.some((item) =>
      coupon.categoryIds.some((id) => String(id) === String(item.category)),
    )
  )
    throw Object.assign(
      new Error("Coupon does not apply to these categories"),
      { status: 400 },
    );
  const used = await CouponRedemption.countDocuments({
    couponId: coupon._id,
    userId,
    status: { $in: ["reserved", "redeemed"] },
  });
  if (used >= coupon.perUserLimit)
    throw Object.assign(new Error("Coupon per-user limit reached"), {
      status: 409,
    });
  if (
    coupon.firstOrderOnly &&
    (await AquaOrder.exists({
      user: userId,
      paymentStatus: { $in: ["Paid", "Pending"] },
    }))
  )
    throw Object.assign(new Error("Coupon is only valid on the first order"), {
      status: 409,
    });
  return { coupon, discount: calculateCouponDiscount(coupon, subtotal) };
};
