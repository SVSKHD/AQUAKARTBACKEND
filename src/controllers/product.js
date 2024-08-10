import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";
import mongoose from "mongoose";

const CreateProduct = async (req, res, next) => {
  try {
    // Ensure files are uploaded
    if (!req.files || !req.files.photos) {
      return next(new CustomError("Images are required", 401));
    }

    // Initialize the image array
    let imageArray = [];

    // Upload photos to Cloudinary
    for (let index = 0; index < req.files.photos.length; index++) {
      let result = await cloudinary.v2.uploader.upload(
        req.files.photos[index].tempFilePath,
        {
          folder: "products",
        },
      );

      imageArray.push({
        id: result.public_id,
        secure_url: result.secure_url,
      });
    }

    // Add the uploaded images to the request body
    req.body.photos = imageArray;

    // Assign the current user to the product
    req.body.user = req.user;

    // Trim and validate ObjectId fields
    const category = req.body.category ? req.body.category.trim() : null;
    const subCategory = req.body.subCategory
      ? req.body.subCategory.trim()
      : null;
    const blog = req.body.blog ? req.body.blog.trim() : null;

    if (category && !mongoose.Types.ObjectId.isValid(category)) {
      return next(new CustomError("Invalid category ID format", 400));
    }

    if (subCategory && !mongoose.Types.ObjectId.isValid(subCategory)) {
      return next(new CustomError("Invalid subCategory ID format", 400));
    }

    if (blog && !mongoose.Types.ObjectId.isValid(blog)) {
      return next(new CustomError("Invalid blog ID format", 400));
    }

    req.body.category = category;
    req.body.subCategory = subCategory;
    req.body.blog = blog;

    // Create the product in the database
    const product = await AquaProduct.create(req.body);

    // Send response
    res.status(200).json({
      success: true,
      product,
    });
  } catch (error) {
    console.error("Error creating product:", error);
    res.status(500).json({
      success: false,
      message: "Product creation failed",
      error: error.message || error,
    });
  }
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      ShortName,
      code,
      discountPriceStatus,
      discountPrice,
      keywords,
      price,
      description,
      notes,
      category,
      subCategory,
      blog,
      stock,
      brand,
      ratings,
      numberOfReviews,
      reviews,
      user,
    } = req.body;

    const photos = [];
    const arPhotos = [];

    // Update photos if provided
    if (req.files.photos) {
      for (const file of req.files.photos) {
        const result = await cloudinary.v2.uploader.upload(file.path, {
          folder: "products",
        });
        photos.push({ id: result.public_id, secure_url: result.secure_url });
      }
    }

    // Update AR photos if provided
    if (req.files.arPhotos) {
      for (const file of req.files.arPhotos) {
        const result = await cloudinary.v2.uploader.upload(file.path, {
          folder: "arProducts",
        });
        arPhotos.push({ id: result.public_id, secure_url: result.secure_url });
      }
    }

    const updatedProduct = await AquaProduct.findByIdAndUpdate(
      id,
      {
        title,
        ShortName,
        code,
        discountPriceStatus,
        discountPrice,
        keywords,
        price,
        description,
        notes,
        photos: photos.length ? photos : undefined,
        arPhotos: arPhotos.length ? arPhotos : undefined,
        category,
        subCategory,
        blog,
        stock,
        brand,
        ratings,
        numberOfReviews,
        reviews,
        user,
      },
      { new: true, runValidators: true },
    );

    res.status(200).json({
      success: true,
      product: updatedProduct,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await AquaProduct.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    // Delete photos from Cloudinary
    for (const photo of product.photos) {
      await cloudinary.v2.uploader.destroy(photo.id);
    }

    // Delete AR photos from Cloudinary
    for (const arPhoto of product.arPhotos) {
      await cloudinary.v2.uploader.destroy(arPhoto.id);
    }

    await product.remove();

    res.status(200).json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

const getProducts = async (req, res) => {
  try {
    const products = await AquaProduct.find({});
    return res.status(200).json({ status: true, data: products });
  } catch (error) {
    console.error("Error getting subcategories:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
const getProduct = async (req, res) => {
  const { id } = req.params;
  try {
    const product = await AquaProduct.findById(id).populate("category");
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "product not found" });
    }
    let relatedProducts = await AquaProduct.find({
      category: product.category,
    });
    relatedProducts = relatedProducts.filter((p) => p.id !== product.id);

    return res
      .status(200)
      .json({ success: true, data: product, related: relatedProducts });
  } catch (error) {
    console.error("Error getting product:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
const ProductOperations = {
  getProducts,
  getProduct,
  CreateProduct,
  updateProduct,
  deleteProduct,
};
export default ProductOperations;
