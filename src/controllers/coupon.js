import Coupon from "../models/coupon.js";
import CouponRedemption from "../models/couponRedemption.js";
import { writeAudit } from "../services/audit.js";

const allowed = [
  "code",
  "description",
  "discountType",
  "discountValue",
  "maxDiscount",
  "minimumOrder",
  "startsAt",
  "endsAt",
  "usageLimit",
  "perUserLimit",
  "firstOrderOnly",
  "stackable",
  "productIds",
  "categoryIds",
  "userIds",
  "status",
];
const pick = (body) =>
  Object.fromEntries(
    allowed
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );

const normalizePayload = (body) => {
  const payload = pick(body);
  if (
    payload.discountValue === undefined &&
    body.discountPercentage !== undefined
  ) {
    payload.discountType = "percentage";
    payload.discountValue = body.discountPercentage;
  }
  if (payload.endsAt === undefined && body.validity !== undefined) {
    payload.endsAt = body.validity;
  }
  if (body.conditions !== undefined && payload.description === undefined) {
    payload.description = body.conditions;
  }
  return payload;
};

const createCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.create({
      ...normalizePayload(req.body),
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    await writeAudit({
      req,
      action: "coupon.create",
      resourceType: "coupon",
      resourceId: coupon._id,
      after: coupon,
    });
    return res.status(201).json({ success: true, data: coupon });
  } catch (error) {
    return res
      .status(error?.code === 11000 ? 409 : 400)
      .json({ success: false, message: error.message });
  }
};

const getCoupons = async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 100);
  const filter = req.query.status ? { status: req.query.status } : {};
  const [data, total] = await Promise.all([
    Coupon.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Coupon.countDocuments(filter),
  ]);
  return res.json({
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
};

const getCouponById = async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  return coupon
    ? res.json({ success: true, data: coupon })
    : res.status(404).json({ success: false, message: "Coupon not found" });
};

const updateCoupon = async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon)
    return res
      .status(404)
      .json({ success: false, message: "Coupon not found" });
  const before = coupon.toObject();
  Object.assign(coupon, normalizePayload(req.body), {
    updatedBy: req.user._id,
  });
  await coupon.save();
  await writeAudit({
    req,
    action: "coupon.update",
    resourceType: "coupon",
    resourceId: coupon._id,
    before,
    after: coupon,
  });
  return res.json({ success: true, data: coupon });
};

const deleteCoupon = async (req, res) => {
  const coupon = await Coupon.findById(req.params.id);
  if (!coupon)
    return res
      .status(404)
      .json({ success: false, message: "Coupon not found" });
  coupon.status = "archived";
  coupon.updatedBy = req.user._id;
  await coupon.save();
  await writeAudit({
    req,
    action: "coupon.archive",
    resourceType: "coupon",
    resourceId: coupon._id,
    after: coupon,
  });
  return res.json({ success: true, data: coupon });
};

const getRedemptions = async (req, res) => {
  const data = await CouponRedemption.find({ couponId: req.params.id })
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  return res.json({ success: true, data });
};

export default {
  createCoupon,
  getCoupons,
  getCouponById,
  updateCoupon,
  deleteCoupon,
  getRedemptions,
};
