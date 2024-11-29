import AquaCoupon from "../models/coupon.js";


const AquaCouponTest = (req,res)=>{
    res.send("Coupon Route Working");
}

// CREATE: Add a new coupon
export const createCoupon = async (req, res) => {
  try {
    const { code, description, discountPercentage, validity, conditions } = req.body;

    const newCoupon = new AquaCoupon({
      code,
      description,
      discountPercentage,
      validity,
      conditions,
    });

    await newCoupon.save();

    res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      data: newCoupon,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// READ: Get all coupons
export const getCoupons = async (req, res) => {
  try {
    const coupons = await AquaCoupon.find();
    res.status(200).json({
      success: true,
      data: coupons,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// READ: Get a specific coupon by ID
export const getCouponById = async (req, res) => {
  try {
    const { id } = req.params;
    const coupon = await AquaCoupon.findById(id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      data: coupon,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// UPDATE: Update a coupon by ID
export const updateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const updatedCoupon = await AquaCoupon.findByIdAndUpdate(id, updates, {
      new: true, // Return the updated document
      runValidators: true, // Enforce validation rules
    });

    if (!updatedCoupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Coupon updated successfully",
      data: updatedCoupon,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// DELETE: Delete a coupon by ID
export const deleteCoupon = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedCoupon = await AquaCoupon.findByIdAndDelete(id);

    if (!deletedCoupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


const AquaCouponOperations = {
    AquaCouponTest,
    createCoupon,
    getCoupons,
    getCouponById,
    updateCoupon,
    deleteCoupon,   
}

export default AquaCouponOperations;