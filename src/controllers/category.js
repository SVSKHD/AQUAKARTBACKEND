import cloudinary from "cloudinary";
import AquaCategory from "../models/category.js";
import AquaProduct from "../models/product.js";
import AquaSubCategory from "../models/sub-category.js";
import mongoose from "mongoose";
import { CloudinaryUtils } from "../utils/cloudinaryUtils/crud.js";

const streamUpload = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { folder: "categories" },
      (error, result) => {
        if (result) {
          resolve(result);
        } else {
          reject(error);
        }
      },
    );
    stream.end(buffer);
  });

const deletePhoto = async (publicId) => {
  try {
    const result = await cloudinary.v2.uploader.destroy(publicId);
    console.log("Deleted photo:", result);
    return result;
  } catch (error) {
    console.error("Error deleting photo:", error);
    throw error;
  }
};


const isDataImage = (value) => typeof value === "string" && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
const resolveImages = async (req, existing = []) => {
  const incoming = req.body.photos;
  if (incoming === undefined && (!req.files || !req.files.length)) return null;
  if (incoming !== undefined && !Array.isArray(incoming)) throw Object.assign(new Error("photos must be an array"), { status: 400 });
  const existingMap = new Map(existing.map((photo) => [String(photo.id), photo]));
  const retained = [], uploaded = [];
  try {
    for (const photo of incoming || []) {
      const source = typeof photo === "string" ? photo : photo?.secure_url;
      if (isDataImage(source)) {
        const result = await cloudinary.v2.uploader.upload(source, { folder: "categories" });
        uploaded.push({ id: result.public_id, secure_url: result.secure_url });
      } else if (photo && existingMap.has(String(photo.id)) && existingMap.get(String(photo.id)).secure_url === photo.secure_url) {
        const saved = existingMap.get(String(photo.id));
        retained.push({ id: saved.id, secure_url: saved.secure_url });
      } else {
        throw Object.assign(new Error("Invalid photo: provide a base64 image or a retained image"), { status: 400 });
      }
    }
    for (const file of req.files || []) {
      const result = await streamUpload(file.buffer);
      uploaded.push({ id: result.public_id, secure_url: result.secure_url });
    }
    return { photos: [...retained, ...uploaded], uploaded };
  } catch (error) {
    await Promise.allSettled(uploaded.map((photo) => deletePhoto(photo.id)));
    throw error;
  }
};

const addCategory = async (req, res) => {
  let uploaded = [];
  try {
    const { title, description, keywords } = req.body;
    if (!String(title || "").trim()) return res.status(400).json({ success: false, message: "Title is required" });
    const images = await resolveImages(req);
    uploaded = images?.uploaded || [];
    const data = await AquaCategory.create({ title, description, keywords, photos: images?.photos || [] });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    await Promise.allSettled(uploaded.map((photo) => deletePhoto(photo.id)));
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const getAllCategories = async (req, res) => {
  try {
    let categories = await AquaCategory.find({});

    categories = categories.map((category) => ({
      ...category._doc,
      photos: (category.photos || []).map((photo) => ({
        ...photo._doc,
        delivery_url: CloudinaryUtils.cloudinaryDeliveryUrl(photo.secure_url),
      })),
    }));

    return res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error("Error getting categories:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getCategory = async (req, res) => {
  const { id } = req.params;
  try {
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid category ID" });
    const category = await AquaCategory.findById(id);
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    const products = await AquaProduct.find({ category: id });
    return res.status(200).json({ success: true, data: category, relatedProducts: products });
  } catch (error) {
    console.error("Error getting category:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getCategoryByTitle = async (req, res) => {
  const title = decodeURIComponent(req.params.title || "");

  try {
    const category = await AquaCategory.findOne({ title });
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }

    const products = await AquaProduct.find({ category: category._id });
    return res
      .status(200)
      .json({ success: true, data: category, relatedProducts: products });
  } catch (error) {
    console.error("Error getting category:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

const updateCategory = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid category ID" });
  let uploaded = [];
  try {
    const existing = await AquaCategory.findById(id);
    if (!existing) return res.status(404).json({ success: false, message: "Category not found" });
    const changes = {};
    for (const field of ["title", "description", "keywords"]) if (req.body[field] !== undefined) changes[field] = req.body[field];
    if (changes.title !== undefined && !String(changes.title).trim()) return res.status(400).json({ success: false, message: "Title is required" });
    const images = await resolveImages(req, existing.photos);
    if (images) {
      changes.photos = images.photos;
      uploaded = images.uploaded;
    }
    const updated = await AquaCategory.findByIdAndUpdate(id, changes, { new: true, runValidators: true });
    if (images) {
      const kept = new Set(images.photos.map((photo) => String(photo.id)));
      await Promise.allSettled(existing.photos.filter((photo) => !kept.has(String(photo.id))).map((photo) => deletePhoto(photo.id)));
    }
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    await Promise.allSettled(uploaded.map((photo) => deletePhoto(photo.id)));
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

const deleteCategory = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ success: false, message: "Invalid category ID" });
  try {
    const category = await AquaCategory.findById(id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    const [subcategories, products] = await Promise.all([
      AquaSubCategory.countDocuments({ category: id }),
      AquaProduct.countDocuments({ category: id }),
    ]);
    if (subcategories || products) return res.status(409).json({
      success: false,
      message: "Cannot delete category while subcategories or products reference it",
    });
    await AquaCategory.findByIdAndDelete(id);
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    console.error("Error deleting category:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const CategoryOperations = {
  addCategory,
  getAllCategories,
  getCategory,
  getCategoryByTitle,
  updateCategory,
  deleteCategory,
};
export default CategoryOperations;
