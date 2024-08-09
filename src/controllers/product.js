import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";

const streamUpload = (buffer, folder) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (result) {
          resolve(result);
        } else {
          reject(error);
        }
      }
    );
    stream.end(buffer);
  });
};
const CreateProduct = async(req,res)=>{
const {title, description} = req.body
console.log("title", title, description)
}

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
  addProduct:async (req, res) => {
    try {
      const { title, description, price, category } = req.body;
      console.log("req",req.body)
      // Basic validation
      if (!title || !description || !price || !category) {
        return res.status(400).json({ success: false, message: "All fields are required" });
      }

   

     
      res.status(201).json({ success: true, data: title });
    } catch (error) {
      console.error("Error adding product:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
  CreateProduct,
  updateProduct,
  deleteProduct,
};
export default ProductOperations;
