import AquaProduct from "../models/product.js";
import cloudinary from "cloudinary";
import { CloudinaryUtils } from "../utils/cloudinaryUtils/crud.js";

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
    if (
      newImageArray.length > 0 &&
      product.photos?.length > 0 &&
      files?.photos?.length > 0
    ) {
      console.log("Deleting old photos:", product.photos);
      await deleteMedia(product.photos);
    }

    if (
      newArImageArray.length > 0 &&
      product.arPhotos?.length > 0 &&
      files?.ar?.length > 0
    ) {
      console.log("Deleting old AR photos:", product.arPhotos);
      await deleteMedia(product.arPhotos);
    }

    // Update the request body with new or retained images
    req.body.photos = newImageArray;
    req.body.arPhotos = newArImageArray;

    console.log("Updated photos:", req.body.photos);
    console.log("Updated AR photos:", req.body.arPhotos);

    // Proceed with updating the product in the database
    const updatedProduct = await AquaProduct.findByIdAndUpdate(id, req.body, {
      new: true,
    });

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

const getAllProducts = async (req, res) => {
  try {
    const { query } = req.query;

    let products = await AquaProduct.find({}).select(
      query === "ecom" ? "-dpPrice" : "",
    );

    if (query === "ecom") {
      products = products.map((product) => ({
        ...product._doc,
        photos: (product.photos || []).map((photo) => ({
          ...photo._doc, // important: keep id, secure_url, _id
          delivery_url: CloudinaryUtils.cloudinaryDeliveryUrl(photo.secure_url),
        })),
        arPhotos: (product.arPhotos || []).map((photo) => ({
          ...photo._doc,
          delivery_url: CloudinaryUtils.cloudinaryDeliveryUrl(photo.secure_url),
        })),
      }));
    }

    return res.status(200).json({ status: true, data: products });
  } catch (error) {
    console.error("Error getting products:", error);
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

const addRatingsComments = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (!rating || !comment) {
      return res.status(400).json({
        success: false,
        message: "Rating and comment are required",
      });
    }

    const parsedRating = Number(rating);
    if (parsedRating < 1 || parsedRating > 5) {
      return res.status(400).json({
        success: false,
        message: "Rating must be between 1 and 5",
      });
    }

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    // One review per user — update if exists, else push new
    const existingIndex = product.reviews.findIndex(
      (r) => r.user.toString() === req.user._id.toString(),
    );

    if (existingIndex !== -1) {
      product.reviews[existingIndex].rating = parsedRating;
      product.reviews[existingIndex].comment = comment;
      product.reviews[existingIndex].createdAt = new Date();
    } else {
      product.reviews.push({
        user: req.user._id,
        name: req.user.firstName
          ? `${req.user.firstName} ${req.user.lastName || ""}`.trim()
          : req.user.name || "Anonymous",
        rating: parsedRating,
        comment,
        createdAt: new Date(),
      });
    }

    product.numberOfReviews = product.reviews.length;
    product.ratings =
      product.reviews.reduce((acc, r) => acc + r.rating, 0) /
      product.reviews.length;

    await product.save();

    return res.status(200).json({
      success: true,
      message:
        existingIndex !== -1
          ? "Review updated successfully"
          : "Review added successfully",
      data: {
        ratings: product.ratings,
        numberOfReviews: product.numberOfReviews,
        reviews: product.reviews,
      },
    });
  } catch (error) {
    console.error("Error adding review:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const getProductReviews = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await AquaProduct.findById(id)
      .select("title ratings numberOfReviews reviews")
      .populate("reviews.user", "firstName lastName name email");

    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const sortedReviews = [...product.reviews].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    return res.status(200).json({
      success: true,
      data: {
        productId: product._id,
        title: product.title,
        ratings: product.ratings,
        numberOfReviews: product.numberOfReviews,
        reviews: sortedReviews,
      },
    });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const deleteReview = async (req, res) => {
  try {
    const { id } = req.params; // product id
    const { reviewId } = req.query; // review subdoc _id

    if (!reviewId) {
      return res
        .status(400)
        .json({ success: false, message: "reviewId query param is required" });
    }

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const reviewIndex = product.reviews.findIndex(
      (r) => r._id.toString() === reviewId,
    );

    if (reviewIndex === -1) {
      return res
        .status(404)
        .json({ success: false, message: "Review not found" });
    }

    const review = product.reviews[reviewIndex];
    const isOwner = review.user.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res
        .status(403)
        .json({ success: false, message: "Not authorized to delete this review" });
    }

    product.reviews.splice(reviewIndex, 1);
    product.numberOfReviews = product.reviews.length;
    product.ratings =
      product.reviews.length > 0
        ? product.reviews.reduce((acc, r) => acc + r.rating, 0) /
          product.reviews.length
        : 0;

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Review deleted successfully",
      data: {
        ratings: product.ratings,
        numberOfReviews: product.numberOfReviews,
      },
    });
  } catch (error) {
    console.error("Error deleting review:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

const ProductOperations = {
  getAllProducts,
  getProduct,
  getProductByTitle,
  getProductByQuery,
  getLimitedProducts,
  CreateProduct,
  updateProduct,
  deleteProduct,
  addRatingsComments,
  getProductReviews,
  deleteReview,
};
export default ProductOperations;
