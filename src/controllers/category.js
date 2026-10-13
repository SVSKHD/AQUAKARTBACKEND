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

const addCategory = async (req, res) => {
  try {
    const { title, description, keywords } = req.body;
    if (!String(title || "").trim()) return res.status(400).json({ success: false, message: "Title is required" });
    const photos = req.files;

    if (!photos || photos.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No photos provided" });
    }

    const uploadedPhotos = [];
    for (const photo of photos) {
      const result = await streamUpload(photo.buffer);
      uploadedPhotos.push({
        id: result.public_id,
        secure_url: result.secure_url,
      });
    }

    const newCategory = new AquaCategory({
      title,
      description,
      photos: uploadedPhotos,
      keywords,
    });

    await newCategory.save();
    return res.status(201).json({ success: true, data: newCategory });
  } catch (error) {
    console.error("Error adding category:", error);
    return res.status(500).json({ success: false, message: error.message });
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
  try {
    const category = await AquaCategory.findById(id);
    if (!category) return res.status(404).json({ success: false, message: "Category not found" });
    const changes = {};
    for (const field of ["title", "description", "keywords"]) {
      if (req.body[field] !== undefined) changes[field] = req.body[field];
    }
    if (changes.title !== undefined && !String(changes.title).trim()) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }
    const uploaded = [];
    try {
      for (const photo of req.files || []) {
        const result = await streamUpload(photo.buffer);
        uploaded.push({ id: result.public_id, secure_url: result.secure_url });
      }
      if (uploaded.length) changes.photos = uploaded;
      const updated = await AquaCategory.findByIdAndUpdate(id, changes, { new: true, runValidators: true });
      if (uploaded.length) {
        for (const photo of category.photos || []) {
          if (photo.id) await deletePhoto(photo.id).catch(console.error);
        }
      }
      return res.status(200).json({ success: true, data: updated });
    } catch (error) {
      for (const photo of uploaded) await deletePhoto(photo.id).catch(console.error);
      throw error;
    }
  } catch (error) {
    console.error("Error updating category:", error);
    return res.status(500).json({ success: false, message: error.message });
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
