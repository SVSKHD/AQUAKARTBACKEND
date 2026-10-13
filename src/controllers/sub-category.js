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


const isDataImage = (value) => typeof value === "string" && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
const normalizePhotos = async (photos, existing = []) => {
  if (!Array.isArray(photos)) throw Object.assign(new Error("photos must be an array"), { status: 400 });
  const retained = [];
  const uploaded = [];
  const allowed = new Map(existing.map((photo) => [String(photo.id), photo]));
  try {
    for (const photo of photos) {
      const input = typeof photo === "string" ? photo : photo?.secure_url;
      if (isDataImage(input)) {
        const result = await cloudinary.v2.uploader.upload(input, { folder: "subcategories" });
        uploaded.push({ id: result.public_id, secure_url: result.secure_url });
      } else if (photo && typeof photo === "object" && allowed.has(String(photo.id)) &&
        allowed.get(String(photo.id)).secure_url === photo.secure_url) {
        const saved = allowed.get(String(photo.id));
        retained.push({ id: saved.id, secure_url: saved.secure_url });
      } else {
        throw Object.assign(new Error("Invalid photo: provide a base64 data image or an existing image"), { status: 400 });
      }
    }
    return { photos: [...retained, ...uploaded], uploaded };
  } catch (error) {
    await Promise.allSettled(uploaded.map((photo) => cloudinary.v2.uploader.destroy(photo.id)));
    throw error;
  }
};

const addSubCategory = async (req, res) => {
  let uploaded = [];
  try {
    const { title, description, keywords } = req.body;
    if (!String(title || "").trim()) return res.status(400).json({ success: false, message: "Title is required" });
    const category = resolveCategoryId(req.body);
    const error = await validateCategoryId(category);
    if (error) return res.status(400).json({ success: false, message: error });
    const result = await normalizePhotos(req.body.photos ?? []);
    uploaded = result.uploaded;
    const data = await AquaSubCategory.create({ title, description, keywords, category, photos: result.photos });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    await Promise.allSettled(uploaded.map((photo) => cloudinary.v2.uploader.destroy(photo.id)));
    return res.status(error.status || 500).json({ success: false, message: error.message });
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
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid subcategory ID" });
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
  let uploaded = [];
  try {
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid subcategory ID" });
    const existing = await AquaSubCategory.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Subcategory not found" });
    const category = resolveCategoryId(req.body);
    if (category !== undefined) {
      const error = await validateCategoryId(category);
      if (error) return res.status(400).json({ success: false, message: error });
    }
    const changes = {};
    for (const field of ["title", "description", "keywords"]) {
      if (req.body[field] !== undefined) changes[field] = req.body[field];
    }
    if (changes.title !== undefined && !String(changes.title).trim()) return res.status(400).json({ success: false, message: "Title is required" });
    if (category !== undefined) changes.category = category;
    if (req.body.photos !== undefined) {
      const normalized = await normalizePhotos(req.body.photos, existing.photos);
      changes.photos = normalized.photos;
      uploaded = normalized.uploaded;
    }
    const updated = await AquaSubCategory.findByIdAndUpdate(id, changes, { new: true, runValidators: true }).populate("category");
    if (changes.photos) {
      const kept = new Set(changes.photos.map((photo) => String(photo.id)));
      await Promise.allSettled(existing.photos.filter((photo) => !kept.has(String(photo.id))).map((photo) => cloudinary.v2.uploader.destroy(photo.id)));
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    await Promise.allSettled(uploaded.map((photo) => cloudinary.v2.uploader.destroy(photo.id)));
    console.error("Error updating subcategory:", error);
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const deleteSubCategory = async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid subcategory ID" });
    const referencedProducts = await AquaProduct.countDocuments({ subCategory: id });
    if (referencedProducts) return res.status(409).json({ success: false, message: "Cannot delete subcategory while products reference it" });
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
