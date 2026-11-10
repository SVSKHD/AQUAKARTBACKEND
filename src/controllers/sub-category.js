import mongoose from "mongoose";
import {
  exactTitleFilter,
  publicIdFromUrl,
  removedPhotos,
  resolveCatalogPhotos,
  scheduleMediaCleanup,
  scheduleUploadCleanup,
} from "../utils/catalogPhotos.js";
import AquaProduct from "../models/product.js";
import AquaSubCategory from "../models/sub-category.js";
import AquaCategory from "../models/category.js";

const resolveCategoryId = (body = {}) => body.category ?? body.category_id;

// Photos follow the shared catalog rules (src/utils/catalogPhotos.js):
// existing photos are kept, new data URIs / URLs are uploaded.
export { publicIdFromUrl };
export const resolveSubCategoryPhotos = (photos, uploaded = []) =>
  resolveCatalogPhotos(photos, { folder: "subcategories", uploaded });

const SERVER_ERROR = "Something went wrong, please try again";

// 400/413 from photo checks keep their message; anything else is generic.
const sendError = (res, error, label) => {
  if (error?.statusCode === 400 || error?.statusCode === 413)
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  console.error(`Error ${label}:`, error);
  return res.status(500).json({ success: false, message: SERVER_ERROR });
};

// Titles are unique across all subcategories (GET /subcategory-title/:title
// looks them up globally), matching the MCP taxonomy tools.
const DUPLICATE_TITLE = "A subcategory with this title already exists";
const titleTaken = (title, exceptId) =>
  AquaSubCategory.exists({
    title: exactTitleFilter(title),
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });

const isTrue = (value) => value === true || value === "true";

const validateCategoryId = async (categoryId) => {
  if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
    return "A valid parent category is required";
  }
  return (await AquaCategory.exists({ _id: categoryId }))
    ? null
    : "Parent category not found";
};

const addSubCategory = async (req, res) => {
  const uploaded = [];
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
    if (await titleTaken(title))
      return res.status(409).json({ success: false, message: DUPLICATE_TITLE });
    const uploadedPhotos = await resolveSubCategoryPhotos(photos, uploaded);
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
    scheduleUploadCleanup(uploaded);
    return sendError(res, error, "adding subcategory");
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
  const { title, description, photos, keywords, clearPhotos } = req.body;
  const category = resolveCategoryId(req.body);
  const uploaded = [];
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
      if (
        String(title).trim().toLowerCase() !==
          String(existing.title || "")
            .trim()
            .toLowerCase() &&
        (await titleTaken(title, id))
      )
        return res
          .status(409)
          .json({ success: false, message: DUPLICATE_TITLE });
      updatedData.title = title;
    }
    if (description !== undefined) updatedData.description = description;
    if (keywords !== undefined) updatedData.keywords = keywords;
    if (category !== undefined) updatedData.category = category;
    // Omitted or [] keeps the current photos; otherwise the list replaces
    // them (existing photos in the list are kept, new ones uploaded).
    // clearPhotos: true (with no photos) removes them all.
    const hasPhotos = Array.isArray(photos)
      ? photos.length > 0
      : photos != null;
    if (isTrue(clearPhotos)) {
      if (hasPhotos)
        return res.status(400).json({
          success: false,
          message: "Send either photos or clearPhotos, not both",
        });
      updatedData.photos = [];
    } else if (hasPhotos) {
      updatedData.photos = await resolveSubCategoryPhotos(photos, uploaded);
    }
    const subcategory = await AquaSubCategory.findByIdAndUpdate(
      id,
      updatedData,
      { new: true, runValidators: true },
    ).populate("category");
    if (!subcategory) {
      scheduleUploadCleanup(uploaded);
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    }
    // Only photos no longer in the list, and only if nothing else uses them.
    if (updatedData.photos)
      scheduleMediaCleanup(
        removedPhotos(existing.photos || [], updatedData.photos),
      );
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    scheduleUploadCleanup(uploaded);
    return sendError(res, error, "updating subcategory");
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
      return res.status(409).json({
        success: false,
        message: "Cannot delete subcategory while products reference it",
      });
    const subcategory = await AquaSubCategory.findByIdAndDelete(id);
    if (!subcategory) {
      return res
        .status(404)
        .json({ success: false, message: "Subcategory not found" });
    }
    // After the record is gone; photos another record uses are kept.
    scheduleMediaCleanup(subcategory.photos || []);
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    return sendError(res, error, "deleting subcategory");
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
