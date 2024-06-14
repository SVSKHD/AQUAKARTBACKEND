import AquaSubCategory from "../models/sub-category.js";
import cloudinary from "cloudinary";

const addSubCategory = async (req, res) => {
  try {
    const { title, description, photos, keywords, category } = req.body;
    if (!photos || photos.length === 0) {
      throw new Error('No photos provided');
    }
    const uploadedPhotos = [];
    for (const photo of photos) {
      const result = await cloudinary.v2.uploader.upload(photo, {
        folder: 'subcategories', // You can specify the folder in Cloudinary
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
    console.error('Error adding subcategory:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getAllSubCategories = async (req, res) => {
  try {
    const subcategories = await AquaSubCategory.find({}).populate('category');
    return res.status(200).json({ success: true, data: subcategories });
  } catch (error) {
    console.error('Error getting subcategories:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getSubCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const subcategory = await AquaSubCategory.findById(id).populate('category');
    if (!subcategory) {
      return res.status(404).json({ success: false, message: 'Subcategory not found' });
    }
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    console.error('Error getting subcategory:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const updateSubCategory = async (req, res) => {
  const { id } = req.params;
  const { title, description, photos, keywords, category } = req.body;
  try {
    const updatedData = { title, description, keywords, category };
    if (photos && photos.length > 0) {
      const uploadedPhotos = [];
      for (const photo of photos) {
        const result = await cloudinary.v2.uploader.upload(photo, {
          folder: 'subcategories',
        });
        uploadedPhotos.push({
          id: result.public_id,
          secure_url: result.secure_url,
        });
      }
      updatedData.photos = uploadedPhotos;
    }
    const subcategory = await AquaSubCategory.findByIdAndUpdate(id, updatedData, { new: true }).populate('category');
    if (!subcategory) {
      return res.status(404).json({ success: false, message: 'Subcategory not found' });
    }
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    console.error('Error updating subcategory:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteSubCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const subcategory = await AquaSubCategory.findByIdAndDelete(id);
    if (!subcategory) {
      return res.status(404).json({ success: false, message: 'Subcategory not found' });
    }
    return res.status(200).json({ success: true, data: subcategory });
  } catch (error) {
    console.error('Error deleting subcategory:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const SubCategoryOperations = {
  addSubCategory,
  getAllSubCategories,
  getSubCategory,
  updateSubCategory,
  deleteSubCategory,
};

export default SubCategoryOperations
