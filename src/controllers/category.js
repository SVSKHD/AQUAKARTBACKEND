import AquaCategory from "../models/category.js";
import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";
import { CloudinaryUtils } from "../utils/cloudinaryUtils/crud.js";

const streamUpload = (buffer) => {
  return new Promise((resolve, reject) => {
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
};

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
      ...category._doc, // keep all fields (_id, name, etc.)
      photos: (category.photos || []).map((photo) => ({
        ...photo._doc, // keep id, secure_url, _id
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
    const category = await AquaCategory.findById(id);
    const products = await AquaProduct.find({ category: id });
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    return res
      .status(200)
      .json({ success: true, data: category, relatedProducts: products });
  } catch (error) {
    console.error("Error getting category:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getCategoryByTitle = async (req, res) => {
  const { title } = req.params;

  try {
    const category = await AquaCategory.findOne({ title });
    const products = await AquaProduct.find({ category: category._id });
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }
    // Uncomment the next line if you want to fetch related products
    // const products = await AquaProduct.find({ category: category._id });
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
  const { title, description, keywords } = req.body; // Extract text fields
  const photos = req?.files; // Handle new file uploads

  try {
    // Step 1: Find the existing category
    const category = await AquaCategory.findById(id);
    if (!category) {
      return res
        .status(404)
        .json({ success: false, message: "Category not found" });
    }

    // Initialize updated data with existing or provided text fields
    const updatedData = {
      title: title || category.title,
      description: description || category.description,
      keywords: keywords || category.keywords,
      photos: [...category.photos], // Start with existing photos
    };

    // Step 2: Handle new photos if provided
    if (photos && photos.length > 0) {
      try {
        // Delete existing photos from Cloudinary
        if (category.photos && category.photos.length > 0) {
          for (const existingPhoto of category.photos) {
            try {
              await deletePhoto(existingPhoto.id);
            } catch (deleteError) {
              console.error(
                "Error deleting photo from Cloudinary:",
                deleteError,
              );
            }
          }
        }

        // Upload new photos
        const uploadedPhotos = [];
        for (const photo of photos) {
          try {
            const result = await streamUpload(photo.buffer);
            uploadedPhotos.push({
              id: result.public_id,
              secure_url: result.secure_url,
            });
          } catch (uploadError) {
            console.error("Error uploading photo to Cloudinary:", uploadError);
          }
        }

        // Replace photos in updated data if any uploads succeeded
        if (uploadedPhotos.length > 0) {
          updatedData.photos = uploadedPhotos;
        }
      } catch (photoHandlingError) {
        console.error("Error handling photos:", photoHandlingError);
      }
    }

    // Step 3: Update the category in the database
    const updatedCategory = await AquaCategory.findByIdAndUpdate(
      id,
      updatedData,
      {
        new: true, // Ensure the updated document is returned
      },
    );

    // Respond with the updated category
    return res.status(200).json({ success: true, data: updatedCategory });
  } catch (error) {
    console.error("Unexpected error updating category:", error);
    return res.status(200).json({
      success: false,
      message: "An issue occurred during the update. Please check logs.",
    });
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
  getCategoryByTitle,
  updateCategory,
  deleteCategory,
};
export default CategoryOperations;
