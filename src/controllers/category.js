import AquaCategory from "../models/category.js";
import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";

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
  console.log(req?.files);
  const { title, description, keywords } = req.body; // Extract text fields
  let photos = req.files?.photos; // Handle file uploads from req.files
  const uploadedPhotos = [];
  try {
    const updatedData = { title, description, keywords };

    // Check if photos are provided
    if (photos) {
      

      // Handle single photo or multiple photos
      const photoArray = Array.isArray(photos) ? photos : [photos];

      for (const photo of photoArray) {
        const result = await streamUpload(photo.buffer);
        uploadedPhotos.push({
          id: result.public_id,
          secure_url: result.secure_url,
        });
      }

      updatedData.photos = uploadedPhotos;
       // Update photos in the database
    }
console.log("uploaded", updatedData, uploadedPhotos);
    // Update category in the database
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


const updateTest = (req,res, next)=>{
  
  console.log("Update Test,", req.body)
  const {title, description, keywords} = req.body;
  console.log(title, req?.files)
}

const CategoryOperations = {
  addCategory,
  getAllCategories,
  getCategory,
  getCategoryByTitle,
  updateCategory,
  deleteCategory,
  updateTest
};
export default CategoryOperations;
