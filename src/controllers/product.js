import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";


const streamUpload = (buffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { folder: "products" },
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

const deleteMedia = async (mediaArray) => {
  try {
    for (const media of mediaArray) {
      await cloudinary.v2.uploader.destroy(media.id);
    }
  } catch (error) {
    console.error("Error deleting media:", error);
    throw new Error("Failed to delete old media");
  }
};

const CreateProduct = async (req, res, next) => {
  try {
    const photos = req.files?.photos;
    const arPhotos = req.files?.ar;
    if (!photos || photos.length === 0) {
      return next(new Error("Images are required", 401));
    }
    if (photos.length > 10) {
      return next(new Error("Maximum of 10 images allowed", 400));
    }
    // if (!arPhotos || arPhotos.length === 0) {
    //   return next(new Error("AR files are required", 401));
    // }
    if (arPhotos && arPhotos.length > 5) {
      return next(new Error("Maximum of 5 AR files allowed)", 400));
    }
    let imageArray = [];

    for (const photo of photos) {
      if (!photo.buffer) {
        return next(new Error("File buffer is missing", 400));
      }
      const result = await streamUpload(photo.buffer);
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

    // if (category && !mongoose.Types.ObjectId.isValid(category)) {
    //   return next(new Error("Invalid category ID format", 400));
    // }

    // if (subCategory && !mongoose.Types.ObjectId.isValid(subCategory)) {
    //   return next(new Error("Invalid subCategory ID format", 400));
    // }

    // if (blog && !mongoose.Types.ObjectId.isValid(blog)) {
    //   return next(new Error("Invalid blog ID format", 400));
    // }

    // req.body.category = category;
    // req.body.subCategory = subCategory; // req.body.blog = blog;

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
    const { id } = req?.params;
    const files = req?.files;

    let newImageArray = [];
    let newArImageArray = [];

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }
    console.log("Existing product:", product);

    // Handle photo uploads
    if (files?.photos?.length > 0) {
      for (const file of files.photos) {
        const result = await streamUpload(file.buffer, "products");
        newImageArray.push({
          id: result.public_id,
          secure_url: result.secure_url,
        });
      }
    } else {
      newImageArray = product.photos; // Retain existing photos if none are uploaded
    }

    // Handle AR image uploads
    if (files?.ar?.length > 0) {
      for (const file of files.ar) {
        const result = await streamUpload(file.buffer, "ar_products");
        newArImageArray.push({
          id: result.public_id,
          secure_url: result.secure_url,
        });
      }
    } else {
      newArImageArray = product.arPhotos; // Retain existing AR photos if none are uploaded
    }

    // Delete old photos if new ones are uploaded
    if (newImageArray.length > 0 && product.photos?.length > 0 && files?.photos?.length > 0) {
      console.log("Deleting old photos:", product.photos);
      await deleteMedia(product.photos);
    }

    if (newArImageArray.length > 0 && product.arPhotos?.length > 0 && files?.ar?.length > 0) {
      console.log("Deleting old AR photos:", product.arPhotos);
      await deleteMedia(product.arPhotos);
    }

    // Update the request body with new or retained images
    req.body.photos = newImageArray;
    req.body.arPhotos = newArImageArray;

    console.log("Updated photos:", req.body.photos);
    console.log("Updated AR photos:", req.body.arPhotos);

    // Proceed with updating the product in the database
    const updatedProduct = await AquaProduct.findByIdAndUpdate(id, req.body, { new: true });

    res.status(200).json({
      success: true,
      message: "Product updated successfully",
      data: updatedProduct,
    });
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};


const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("Deleting product with ID:", id);
    const product = await AquaProduct.findById(id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    // Delete photos from Cloudinary
    if (product.photos?.length > 0) {
     await deleteMedia(product.photos);
    }

    // Delete AR photos from Cloudinary
    if (product.arPhotos?.length > 0) {
      await deleteMedia(product.arPhotos);
    }

    await AquaProduct.findByIdAndDelete(id);

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

const getLimitedProducts = async (req, res) => {
  const { count } = req.params; // Extracting the 'count' parameter from route params
  const limit = parseInt(count); // Convert the count to a number

  if (isNaN(limit) || limit <= 0) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid product count specified." });
  }

  try {
    const products = await AquaProduct.find({}).limit(limit);
    return res.status(200).json({ status: true, data: products });
  } catch (error) {
    console.error("Error getting limited products:", error);
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

const getProductByTitle = async (req, res) => {
  const { title } = req.params;
  try {
    const product = await AquaProduct.findOne({ title }).populate("category");
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

const getProductByQuery = async (req, res) => {
  const { searchField, value } = req.query; // Dynamically pass the field and value via query parameters

  if (!searchField || !value) {
    return res.status(400).json({
      success: false,
      message: "Missing search field or value",
    });
  }

  try {
    // Dynamically build the query object
    const query = {};
    query[searchField] = value;

    // Search for the product based on the dynamic query
    const product = await AquaProduct.findOne(query).populate("category");

    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    // Fetch related products within the same category, excluding the current product
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
  getProductByTitle,
  getProductByQuery,
  getLimitedProducts,
  CreateProduct,
  updateProduct,
  deleteProduct,
};
export default ProductOperations;
