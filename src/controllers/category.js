import AquaCategory from "../models/category.js";
import cloudinary from "cloudinary";

const addCategory = async (req, res) => {
  try {
    const { title, description, photos, keywords } = req.body;
    if (!photos || photos.length === 0) {
      throw new Error("No photos provided");
    }
    const uploadedPhotos = [];
    for (const photo of photos) {
      const result = await cloudinary.v2.uploader.upload(photo, {
        folder: "categories", // You can specify the folder in Cloudinary
      });
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
    const categories = await AquaCategory.find({});
    return res.status(200).json({ success: true, data: categories });
  } catch (error) {
    console.error("Error getting categories:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const category = await AquaCategory.findById(id);
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    console.error("Error getting category:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { title, description, photos, keywords } = req.body;
  try {
    const updatedData = { title, description, keywords };
    if (photos && photos.length > 0) {
      const uploadedPhotos = [];
      for (const photo of photos) {
        const result = await cloudinary.v2.uploader.upload(photo, {
          folder: "categories",
        });
        uploadedPhotos.push({
          id: result.public_id,
          secure_url: result.secure_url,
        });
      }
      updatedData.photos = uploadedPhotos;
    }
    const category = await AquaCategory.findByIdAndUpdate(id, updatedData, {
      new: true,
    });
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    console.error("Error updating category:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const category = await AquaCategory.findByIdAndDelete(id);
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
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
  updateCategory,
  deleteCategory,
};
export default CategoryOperations;
