import mongoose from "mongoose";
import cloudinary from "cloudinary";
import AquaProduct from "../models/product.js";
import { CloudinaryUtils } from "../utils/cloudinaryUtils/crud.js";

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const ADMIN_ROLE = 1;

const handleControllerError = (
  error,
  res,
  fallbackMessage = "Something went wrong, please try again",
) => {
  if (error?.name === "CastError") {
    return res.status(400).json({
      success: false,
      message: `Invalid value for ${error.path}`,
      field: error.path,
    });
  }
  if (error?.name === "ValidationError") {
    const fields = Object.entries(error.errors || {}).reduce(
      (acc, [field, err]) => {
        acc[field] = err.message;
        return acc;
      },
      {},
    );
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: fields,
    });
  }
  if (error?.code === 11000) {
    const field = Object.keys(error.keyValue || {})[0] || "field";
    return res.status(409).json({
      success: false,
      message: `Duplicate ${field}: a product with this ${field} already exists`,
      field,
    });
  }
  console.error(`${fallbackMessage}:`, error);
  return res.status(500).json({
    success: false,
    message: fallbackMessage,
  });
};

const streamUpload = (buffer, folder = "products") =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (result) resolve(result);
        else reject(error);
      },
    );
    stream.end(buffer);
  });

const deleteMedia = async (mediaArray = []) => {
  for (const media of mediaArray) {
    if (!media?.id) continue;
    await cloudinary.v2.uploader.destroy(media.id);
  }
};

const uploadFiles = async (files = [], folder) => {
  const uploaded = [];
  for (const file of files) {
    if (!file?.buffer) {
      const err = new Error("Uploaded file is missing data");
      err.statusCode = 400;
      throw err;
    }
    try {
      const result = await streamUpload(file.buffer, folder);
      uploaded.push({ id: result.public_id, secure_url: result.secure_url });
    } catch (cloudinaryError) {
      const err = new Error(
        `Image upload failed: ${cloudinaryError?.message || "Cloudinary error"}`,
      );
      err.statusCode = 502;
      throw err;
    }
  }
  return uploaded;
};

const validateProductPayload = (body, { partial = false } = {}) => {
  const errors = {};

  if (!partial || body.title !== undefined) {
    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      errors.title = "Product title is required";
    } else if (body.title.length > 120) {
      errors.title = "Product title must not exceed 120 characters";
    }
  }

  if (!partial || body.price !== undefined) {
    const price = Number(body.price);
    if (body.price === undefined || body.price === null || body.price === "") {
      errors.price = "Product price is required";
    } else if (Number.isNaN(price) || price < 0) {
      errors.price = "Product price must be a non-negative number";
    } else if (String(Math.trunc(price)).length > 6) {
      errors.price = "Product price must not exceed 6 digits";
    }
  }

  if (!partial || body.description !== undefined) {
    if (
      !body.description ||
      typeof body.description !== "string" ||
      !body.description.trim()
    ) {
      errors.description = "Product description is required";
    }
  }

  if (!partial || body.stock !== undefined) {
    const stock = Number(body.stock);
    if (body.stock === undefined || body.stock === null || body.stock === "") {
      errors.stock = "Product stock is required";
    } else if (Number.isNaN(stock) || stock < 0) {
      errors.stock = "Product stock must be a non-negative number";
    }
  }

  if (!partial || body.brand !== undefined) {
    if (!body.brand || typeof body.brand !== "string" || !body.brand.trim()) {
      errors.brand = "Product brand is required";
    }
  }

  if (body.notes && body.notes.length > 300) {
    errors.notes = "Notes must not exceed 300 characters";
  }

  ["category", "subCategory", "blog"].forEach((field) => {
    if (body[field] && !isValidObjectId(String(body[field]).trim())) {
      errors[field] = `Invalid ${field} id`;
    }
  });

  return { isValid: Object.keys(errors).length === 0, errors };
};

// ─────────────────────────────── CRUD ────────────────────────────────────

const CreateProduct = async (req, res) => {
  try {
    const photos = req.files?.photos || [];
    const arPhotos = req.files?.ar || [];

    if (photos.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "At least one product image is required" });
    }
    if (photos.length > 10) {
      return res
        .status(400)
        .json({ success: false, message: "A maximum of 10 product images is allowed" });
    }
    if (arPhotos.length > 5) {
      return res
        .status(400)
        .json({ success: false, message: "A maximum of 5 AR files is allowed" });
    }

    const { isValid, errors } = validateProductPayload(req.body);
    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    const uploadedPhotos = await uploadFiles(photos, "products");
    let uploadedArPhotos = [];
    if (arPhotos.length > 0) {
      uploadedArPhotos = await uploadFiles(arPhotos, "ar_products");
    }

    const payload = {
      ...req.body,
      photos: uploadedPhotos,
      arPhotos: uploadedArPhotos,
      user: req.user?._id,
      category: req.body.category ? String(req.body.category).trim() : undefined,
      subCategory: req.body.subCategory
        ? String(req.body.subCategory).trim()
        : undefined,
      blog: req.body.blog ? String(req.body.blog).trim() : undefined,
    };

    const product = await AquaProduct.create(payload);
    return res.status(201).json({ success: true, data: product });
  } catch (error) {
    if (error?.statusCode) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }
    return handleControllerError(error, res, "Failed to create product");
  }
};

const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const { isValid, errors } = validateProductPayload(req.body, { partial: true });
    if (!isValid) {
      return res
        .status(400)
        .json({ success: false, message: "Validation failed", errors });
    }

    const files = req.files || {};
    const newPhotos = files.photos || [];
    const newArPhotos = files.ar || [];

    if (newPhotos.length > 10) {
      return res
        .status(400)
        .json({ success: false, message: "A maximum of 10 product images is allowed" });
    }
    if (newArPhotos.length > 5) {
      return res
        .status(400)
        .json({ success: false, message: "A maximum of 5 AR files is allowed" });
    }

    let photosPayload = product.photos;
    let arPayload = product.arPhotos;

    if (newPhotos.length > 0) {
      photosPayload = await uploadFiles(newPhotos, "products");
      if (product.photos?.length) {
        try {
          await deleteMedia(product.photos);
        } catch (cleanupError) {
          console.error("Failed to remove old product photos:", cleanupError);
        }
      }
    }
    if (newArPhotos.length > 0) {
      arPayload = await uploadFiles(newArPhotos, "ar_products");
      if (product.arPhotos?.length) {
        try {
          await deleteMedia(product.arPhotos);
        } catch (cleanupError) {
          console.error("Failed to remove old AR photos:", cleanupError);
        }
      }
    }

    const updatePayload = {
      ...req.body,
      photos: photosPayload,
      arPhotos: arPayload,
    };
    delete updatePayload._id;
    delete updatePayload.reviews;
    delete updatePayload.ratings;
    delete updatePayload.numberOfReviews;

    const updated = await AquaProduct.findByIdAndUpdate(id, updatePayload, {
      new: true,
      runValidators: true,
    });

    return res
      .status(200)
      .json({ success: true, message: "Product updated successfully", data: updated });
  } catch (error) {
    if (error?.statusCode) {
      return res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
    }
    return handleControllerError(error, res, "Failed to update product");
  }
};

const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    try {
      if (product.photos?.length) await deleteMedia(product.photos);
      if (product.arPhotos?.length) await deleteMedia(product.arPhotos);
    } catch (cleanupError) {
      console.error("Failed to remove product media:", cleanupError);
    }

    await AquaProduct.findByIdAndDelete(id);

    return res
      .status(200)
      .json({ success: true, message: "Product deleted successfully" });
  } catch (error) {
    return handleControllerError(error, res, "Failed to delete product");
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
          ...photo._doc,
          delivery_url: CloudinaryUtils.cloudinaryDeliveryUrl(photo.secure_url),
        })),
        arPhotos: (product.arPhotos || []).map((photo) => ({
          ...photo._doc,
          delivery_url: CloudinaryUtils.cloudinaryDeliveryUrl(photo.secure_url),
        })),
      }));
    }

    return res.status(200).json({ success: true, count: products.length, data: products });
  } catch (error) {
    return handleControllerError(error, res, "Failed to fetch products");
  }
};

const getLimitedProducts = async (req, res) => {
  try {
    const { count } = req.params;
    const limit = parseInt(count, 10);

    if (Number.isNaN(limit) || limit <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Count must be a positive integer" });
    }

    const products = await AquaProduct.find({}).limit(limit);
    return res.status(200).json({ success: true, count: products.length, data: products });
  } catch (error) {
    return handleControllerError(error, res, "Failed to fetch products");
  }
};

const getProduct = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const product = await AquaProduct.findById(id).populate("category");
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    let relatedProducts = await AquaProduct.find({ category: product.category });
    relatedProducts = relatedProducts.filter(
      (p) => String(p._id) !== String(product._id),
    );

    return res
      .status(200)
      .json({ success: true, data: product, related: relatedProducts });
  } catch (error) {
    return handleControllerError(error, res, "Failed to fetch product");
  }
};

const getProductByTitle = async (req, res) => {
  try {
    const { title } = req.params;
    if (!title || !title.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Product title is required" });
    }

    const product = await AquaProduct.findOne({ title }).populate("category");
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    let relatedProducts = await AquaProduct.find({ category: product.category });
    relatedProducts = relatedProducts.filter(
      (p) => String(p._id) !== String(product._id),
    );

    return res
      .status(200)
      .json({ success: true, data: product, related: relatedProducts });
  } catch (error) {
    return handleControllerError(error, res, "Failed to fetch product");
  }
};

const getProductByQuery = async (req, res) => {
  try {
    const { searchField, value } = req.query;

    if (!searchField || !value) {
      return res
        .status(400)
        .json({ success: false, message: "Both searchField and value are required" });
    }

    const allowedFields = [
      "title",
      "slug",
      "seoSlug",
      "code",
      "ShortName",
      "brand",
    ];
    if (!allowedFields.includes(searchField)) {
      return res.status(400).json({
        success: false,
        message: `searchField must be one of: ${allowedFields.join(", ")}`,
      });
    }

    const product = await AquaProduct.findOne({ [searchField]: value }).populate(
      "category",
    );

    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    let relatedProducts = await AquaProduct.find({ category: product.category });
    relatedProducts = relatedProducts.filter(
      (p) => String(p._id) !== String(product._id),
    );

    return res
      .status(200)
      .json({ success: true, data: product, related: relatedProducts });
  } catch (error) {
    return handleControllerError(error, res, "Failed to fetch product");
  }
};

// ─────────────────────────────── Reviews ─────────────────────────────────

const addRatingsComments = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
    if (rating === undefined || rating === null || rating === "") {
      return res
        .status(400)
        .json({ success: false, message: "Rating is required" });
    }
    if (!comment || typeof comment !== "string" || !comment.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Comment is required" });
    }
    if (comment.length > 1000) {
      return res
        .status(400)
        .json({ success: false, message: "Comment must not exceed 1000 characters" });
    }

    const parsedRating = Number(rating);
    if (Number.isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be a number between 1 and 5" });
    }

    if (!req.user?._id) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const existingIndex = product.reviews.findIndex(
      (r) => r.user.toString() === req.user._id.toString(),
    );

    const reviewerName = req.user.firstName
      ? `${req.user.firstName} ${req.user.lastName || ""}`.trim()
      : req.user.name || "Anonymous";

    if (existingIndex !== -1) {
      product.reviews[existingIndex].rating = parsedRating;
      product.reviews[existingIndex].comment = comment;
      product.reviews[existingIndex].createdAt = new Date();
    } else {
      product.reviews.push({
        user: req.user._id,
        name: reviewerName,
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
    return handleControllerError(error, res, "Failed to save review");
  }
};

const getProductReviews = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }

    const product = await AquaProduct.findById(id)
      .select("title ratings numberOfReviews reviews")
      .populate("reviews.user", "firstName lastName email");

    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const sortedReviews = [...product.reviews]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map((review) => {
        const fallbackName =
          `${review.user?.firstName || ""} ${review.user?.lastName || ""}`.trim() ||
          review.user?.email ||
          "Anonymous";

        return {
          _id: review._id,
          user: review.user?._id || review.user,
          name:
            review.name && review.name !== "Anonymous"
              ? review.name
              : fallbackName,
          email: review.user?.email || null,
          rating: review.rating,
          comment: review.comment,
          createdAt: review.createdAt,
        };
      });

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
    return handleControllerError(error, res, "Failed to fetch product reviews");
  }
};

const updateRatingsComments = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, comment } = req.body;

    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
    if (rating === undefined || rating === null || rating === "") {
      return res
        .status(400)
        .json({ success: false, message: "Rating is required" });
    }
    if (!comment || typeof comment !== "string" || !comment.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Comment is required" });
    }
    if (comment.length > 1000) {
      return res
        .status(400)
        .json({ success: false, message: "Comment must not exceed 1000 characters" });
    }

    const parsedRating = Number(rating);
    if (Number.isNaN(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be a number between 1 and 5" });
    }

    if (!req.user?._id) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
    }

    const product = await AquaProduct.findById(id);
    if (!product) {
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    }

    const existingReview = product.reviews.find(
      (r) => r.user.toString() === req.user._id.toString(),
    );
    if (!existingReview) {
      return res
        .status(404)
        .json({ success: false, message: "You have not reviewed this product yet" });
    }

    existingReview.rating = parsedRating;
    existingReview.comment = comment;
    existingReview.name = req.user.firstName
      ? `${req.user.firstName} ${req.user.lastName || ""}`.trim()
      : req.user.name || "Anonymous";
    existingReview.createdAt = new Date();

    product.numberOfReviews = product.reviews.length;
    product.ratings =
      product.reviews.reduce((acc, r) => acc + r.rating, 0) /
      product.reviews.length;

    await product.save();

    return res.status(200).json({
      success: true,
      message: "Review updated successfully",
      data: {
        ratings: product.ratings,
        numberOfReviews: product.numberOfReviews,
        reviews: product.reviews,
      },
    });
  } catch (error) {
    return handleControllerError(error, res, "Failed to update review");
  }
};

const deleteReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { reviewId } = req.query;

    if (!isValidObjectId(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid product id" });
    }
    if (!reviewId) {
      return res
        .status(400)
        .json({ success: false, message: "reviewId query parameter is required" });
    }
    if (!isValidObjectId(reviewId)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid reviewId" });
    }
    if (!req.user?._id) {
      return res
        .status(401)
        .json({ success: false, message: "Authentication required" });
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
    const isAdmin = Number(req.user.role) === ADMIN_ROLE;

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to delete this review",
      });
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
    return handleControllerError(error, res, "Failed to delete review");
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
  updateRatingsComments,
};

export default ProductOperations;
