import cloudinary from "cloudinary";
import AquaCategory from "../models/category.js";
import AquaProduct from "../models/product.js";
import AquaSubCategory from "../models/sub-category.js";
import mongoose from "mongoose";
import { CloudinaryUtils } from "../utils/cloudinaryUtils/crud.js";
import {
  assertImageBuffer,
  exactTitleFilter,
  removedPhotos,
  resolveCatalogPhotos,
  scheduleMediaCleanup,
  scheduleUploadCleanup,
} from "../utils/catalogPhotos.js";

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

const DUPLICATE_TITLE = "A category with this title already exists";
const titleTaken = (title, exceptId) =>
  AquaCategory.exists({
    title: exactTitleFilter(title),
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });

// Multipart files: every file is checked before any is uploaded.
const uploadFiles = async (files, uploaded) => {
  for (const file of files) assertImageBuffer(file.buffer, file.mimetype);
  for (const file of files) {
    const result = await streamUpload(file.buffer);
    uploaded.push({ id: result.public_id, secure_url: result.secure_url });
  }
  return uploaded;
};

const addCategory = async (req, res) => {
  const uploaded = [];
  try {
    const { title, description, keywords } = req.body;
    if (!String(title || "").trim())
      return res
        .status(400)
        .json({ success: false, message: "Title is required" });
    if (await titleTaken(title))
      return res.status(409).json({ success: false, message: DUPLICATE_TITLE });
    const files = req.files || [];
    // Multipart file uploads, or JSON photos (what the CRM sends).
    const photos = files.length
      ? await uploadFiles(files, uploaded)
      : await resolveCatalogPhotos(req.body.photos, {
          folder: "categories",
          uploaded,
        });

    if (!photos.length) {
      return res
        .status(400)
        .json({ success: false, message: "No photos provided" });
    }

    const newCategory = new AquaCategory({
      title,
      description,
      photos,
      keywords,
    });

    await newCategory.save();
    return res.status(201).json({ success: true, data: newCategory });
  } catch (error) {
    scheduleUploadCleanup(uploaded);
    return sendError(res, error, "adding category");
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
    if (!mongoose.isValidObjectId(id))
      return res
        .status(400)
        .json({ success: false, message: "Invalid category ID" });
    const category = await AquaCategory.findById(id);
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    const products = await AquaProduct.find({ category: id });
    return res
      .status(200)
      .json({ success: true, data: category, relatedProducts: products });
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
  if (!mongoose.isValidObjectId(id))
    return res
      .status(400)
      .json({ success: false, message: "Invalid category ID" });
  try {
    const category = await AquaCategory.findById(id);
    if (!category)
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    const changes = {};
    for (const field of ["title", "description", "keywords"]) {
      if (req.body[field] !== undefined) changes[field] = req.body[field];
    }
    if (changes.title !== undefined && !String(changes.title).trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Title is required" });
    }
    // Only a changed title is checked, so re-saving an existing record works.
    if (
      changes.title !== undefined &&
      String(changes.title).trim().toLowerCase() !==
        String(category.title || "")
          .trim()
          .toLowerCase() &&
      (await titleTaken(changes.title, id))
    )
      return res.status(409).json({ success: false, message: DUPLICATE_TITLE });
    const uploaded = [];
    try {
      const files = req.files || [];
      if (files.length) {
        // Multipart: the uploaded files replace the whole list.
        changes.photos = await uploadFiles(files, uploaded);
      } else if (Array.isArray(req.body.photos) && req.body.photos.length) {
        // JSON (CRM): existing photos in the list are kept, new ones uploaded.
        // An empty or omitted list keeps the current photos.
        changes.photos = await resolveCatalogPhotos(req.body.photos, {
          folder: "categories",
          uploaded,
        });
      }
      const updated = await AquaCategory.findByIdAndUpdate(id, changes, {
        new: true,
        runValidators: true,
      });
      if (!updated) {
        scheduleUploadCleanup(uploaded);
        return res
          .status(404)
          .json({ success: false, message: "Category not found" });
      }
      // Only photos no longer in the list, and only if nothing else uses them.
      if (changes.photos)
        scheduleMediaCleanup(
          removedPhotos(category.photos || [], changes.photos),
        );
      return res.status(200).json({ success: true, data: updated });
    } catch (error) {
      scheduleUploadCleanup(uploaded);
      throw error;
    }
  } catch (error) {
    return sendError(res, error, "updating category");
  }
};

const deleteCategory = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id))
    return res
      .status(400)
      .json({ success: false, message: "Invalid category ID" });
  try {
    const category = await AquaCategory.findById(id);
    if (!category)
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    const [subcategories, products] = await Promise.all([
      AquaSubCategory.countDocuments({ category: id }),
      AquaProduct.countDocuments({ category: id }),
    ]);
    if (subcategories || products)
      return res.status(409).json({
        success: false,
        message:
          "Cannot delete category while subcategories or products reference it",
      });
    await AquaCategory.findByIdAndDelete(id);
    // After the record is gone; photos another record uses are kept.
    scheduleMediaCleanup(category.photos || []);
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    return sendError(res, error, "deleting category");
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
