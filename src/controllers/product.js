import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";

const addProduct = async (req, res) => {
  try {
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

    // Upload photos to Cloudinary
    if (req.files.photos) {
      for (const file of req.files.photos) {
        const result = await cloudinary.v2.uploader.upload(file.path, {
          folder: "products",
        });
        photos.push({ id: result.public_id, secure_url: result.secure_url });
      }
    }

    // Upload AR photos to Cloudinary
    if (req.files.arPhotos) {
      for (const file of req.files.arPhotos) {
        const result = await cloudinary.v2.uploader.upload(file.path, {
          folder: "arProducts",
        });
        arPhotos.push({ id: result.public_id, secure_url: result.secure_url });
      }
    }

    const product = new AquaProduct({
      title,
      ShortName,
      code,
      discountPriceStatus,
      discountPrice,
      keywords,
      price,
      description,
      notes,
      photos,
      arPhotos,
      category,
      subCategory,
      blog,
      stock,
      brand,
      ratings,
      numberOfReviews,
      reviews,
      user,
    });

    await product.save();

    res.status(201).json({
      success: true,
      product,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
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
      { new: true, runValidators: true }
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
    return res.status(200).json({ success: true, data: product });
  } catch (error) {
    console.error("Error getting product:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
const ProductOperations = {
  getProducts,
  getProduct,
  addProduct,
  updateProduct,
  deleteProduct
};
export default ProductOperations;
