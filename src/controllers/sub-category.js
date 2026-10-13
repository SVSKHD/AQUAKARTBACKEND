import mongoose from "mongoose";
import cloudinary from "cloudinary";
import AquaProduct from "../models/product.js";
import AquaSubCategory from "../models/sub-category.js";
import AquaCategory from "../models/category.js";

const resolveCategoryId = (body = {}) => body.category ?? body.category_id;

const validateCategoryId = async (categoryId) => {
  if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
    return "A valid parent category is required";
  }
  return (await AquaCategory.exists({ _id: categoryId }))
    ? null
    : "Parent category not found";
};

const addSubCategory = async (req, res) => {
  try {
    const { title, description, photos, keywords } = req.body;
    const category = resolveCategoryId(req.body);
    const categoryError = await validateCategoryId(category);
    if (categoryError) {
      return res.status(400).json({ success: false, message: categoryError });
    }
    if (!String(title || "").trim()) return res.status(400).json({ success: false, message: "Title is required" });
    const uploadedPhotos = [];
    for (const photo of photos || []) {
      const result = await cloudinary.v2.uploader.upload(photo, {
        folder: "subcategories", // You can specify the folder in Cloudinary
      });
      uploadedPhotos.push({
        id: result.public_id,
        secure_url: result.secure_url,
      });
    }
    const newSubCategory = new AquaSubCategory({
      title,
      description,
      photos: uploadedPhotos,
      keywords,
      category,
    });
    await newSubCategory.save();
    return res.status(201).json({ success: true, data: newSubCategory });
  } catch (error) {
    console.error("Error adding subcategory:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAllSubCategories = async (req, res) => {
  try {
    const subcategories = await AquaSubCategory.find({}).populate("category");
    return res.status(200).json({ success: true, data: subcategories });
  } catch (error) {
    console.error("Error getting subcategories:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getSubCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const subcategory = await AquaSubCategory.findById(id).populate("category");
    if (!subcategory) {
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    }
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    console.error("Error getting subcategory:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getSubCategoryByTitle = async (req, res) => {
  const title = decodeURIComponent(req.params.title || "");

  try {
    const subcategory = await AquaSubCategory.findOne({ title }).populate(
      "category",
    );
    if (!subcategory) {
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    }

    const products = await AquaProduct.find({ subCategory: subcategory._id });
    return res.status(200).json({
      success: true,
      data: subcategory,
      relatedProducts: products,
    });
  } catch (error) {
    console.error("Error getting subcategory:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const updateSubCategory = async (req, res) => {
  const { id } = req.params;
  const { title, description, photos, keywords } = req.body;
  const category = resolveCategoryId(req.body);
  try {
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid subcategory ID" });
    const existing = await AquaSubCategory.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Subcategory not found" });
    const categoryError = await validateCategoryId(category ?? existing.category);
    if (categoryError) {
      return res.status(400).json({ success: false, message: categoryError });
    }
    const updatedData = {};
    if (title !== undefined) {
      if (!String(title).trim()) return res.status(400).json({ success: false, message: "Title is required" });
      updatedData.title = title;
    }
    if (description !== undefined) updatedData.description = description;
    if (keywords !== undefined) updatedData.keywords = keywords;
    if (category !== undefined) updatedData.category = category;
    if (photos && photos.length > 0) {
      const uploadedPhotos = [];
      for (const photo of photos) {
        const result = await cloudinary.v2.uploader.upload(photo, {
          folder: "subcategories",
        });
        uploadedPhotos.push({
          id: result.public_id,
          secure_url: result.secure_url,
        });
      }
      updatedData.photos = uploadedPhotos;
    }
    const subcategory = await AquaSubCategory.findByIdAndUpdate(
      id,
      updatedData,
      { new: true, runValidators: true },
    ).populate("category");
    if (!subcategory) {
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    }
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    console.error("Error updating subcategory:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteSubCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const subcategory = await AquaSubCategory.findByIdAndDelete(id);
    if (!subcategory) {
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    }
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    console.error("Error deleting subcategory:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const SubCategoryOperations = {
  addSubCategory,
  getAllSubCategories,
  getSubCategory,
  getSubCategoryByTitle,
  updateSubCategory,
  deleteSubCategory,
};

export default SubCategoryOperations;
