import mongoose from "mongoose";
import {
  publicIdFromUrl,
  resolveCatalogPhotos,
} from "../utils/catalogPhotos.js";
import AquaProduct from "../models/product.js";
import AquaSubCategory from "../models/sub-category.js";
import AquaCategory from "../models/category.js";

const resolveCategoryId = (body = {}) => body.category ?? body.category_id;

// Photos follow the shared catalog rules (src/utils/catalogPhotos.js):
// existing photos are kept, new data URIs / URLs are uploaded.
export { publicIdFromUrl };
export const resolveSubCategoryPhotos = (photos) =>
  resolveCatalogPhotos(photos, { folder: "subcategories" });

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
    if (!String(title || "").trim())
      return res
        .status(400)
        .json({ success: false, message: "Title is required" });
    const uploadedPhotos = await resolveSubCategoryPhotos(photos);
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
    if (error?.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });
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
    if (!mongoose.isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid subcategory ID" });
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
  const id = req.params.id ?? req.body.id ?? req.body._id;
  const { title, description, photos, keywords } = req.body;
  const category = resolveCategoryId(req.body);
  try {
    if (!mongoose.isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid subcategory ID" });
    const existing = await AquaSubCategory.findById(id);
    if (!existing)
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    const categoryError = await validateCategoryId(
      category ?? existing.category,
    );
    if (categoryError) {
      return res.status(400).json({ success: false, message: categoryError });
    }
    const updatedData = {};
    if (title !== undefined) {
      if (!String(title).trim())
        return res
          .status(400)
          .json({ success: false, message: "Title is required" });
      updatedData.title = title;
    }
    if (description !== undefined) updatedData.description = description;
    if (keywords !== undefined) updatedData.keywords = keywords;
    if (category !== undefined) updatedData.category = category;
    // Omitted or [] keeps the current photos; otherwise the list replaces
    // them (existing photos in the list are kept, new ones uploaded).
    if (Array.isArray(photos) ? photos.length > 0 : photos != null) {
      updatedData.photos = await resolveSubCategoryPhotos(photos);
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
    if (error?.statusCode === 400)
      return res.status(400).json({ success: false, message: error.message });
    console.error("Error updating subcategory:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteSubCategory = async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid subcategory ID" });
    const referencedProducts = await AquaProduct.countDocuments({
      subCategory: id,
    });
    if (referencedProducts)
      return res
        .status(409)
        .json({
          success: false,
          message: "Cannot delete subcategory while products reference it",
        });
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
