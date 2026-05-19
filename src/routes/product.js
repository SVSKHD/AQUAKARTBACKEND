import express from "express";
import multer from "multer";
import ProductOperations from "../controllers/product.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
});

const PRODUCT_PHOTO_FIELDS = new Set([
  "photos",
  "photos[]",
  "photo",
  "image",
  "images",
  "productPhoto",
  "productPhotos",
  "productImages",
]);

const PRODUCT_AR_FIELDS = new Set([
  "ar",
  "ar[]",
  "arPhoto",
  "arPhotos",
  "arImage",
  "arImages",
]);

const normalizeProductMediaFiles = (req, res, next) => {
  const files = Array.isArray(req.files) ? req.files : [];

  const normalizedFiles = {
    photos: [],
    ar: [],
  };

  const unexpectedFields = [];

  files.forEach((file) => {
    if (PRODUCT_PHOTO_FIELDS.has(file.fieldname)) {
      normalizedFiles.photos.push(file);
      return;
    }

    if (PRODUCT_AR_FIELDS.has(file.fieldname)) {
      normalizedFiles.ar.push(file);
      return;
    }

    unexpectedFields.push(file.fieldname);
  });

  if (unexpectedFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: "Unsupported product media field",
      allowedPhotoFields: [...PRODUCT_PHOTO_FIELDS],
      allowedArFields: [...PRODUCT_AR_FIELDS],
      receivedFields: [...new Set(unexpectedFields)],
    });
  }

  req.files = normalizedFiles;
  return next();
};

const productMediaUpload = [
  upload.any(),
  normalizeProductMediaFiles,
];

const handleMulterError = (error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: error.message,
      code: error.code,
      field: error.field,
    });
  }

  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || "Product media upload failed",
    });
  }

  return next();
};

router.get("/product-status", (req, res) => {
  res.json({ message: "product status v1 active" });
});
router.get("/all-products", ProductOperations.getAllProducts);
router.get("/product/:id", ProductOperations.getProduct);
router.get("/product-title/:title", ProductOperations.getProductByTitle);
router.get("/products/:count", ProductOperations.getLimitedProducts);
router.get("/product", ProductOperations.getProductByQuery);

// ─── Reviews & Comments ────────────────────────────────────────────────────
router.get("/product/review/:id", ProductOperations.getProductReviews);
router.post(
  "/product/review/:id",
  userAuth.isLoggedIn,
  ProductOperations.addRatingsComments,
);

router.put(
  "/product/review/:id",
  userAuth.isLoggedIn,
  ProductOperations.updateRatingsComments,
);

router.delete(
  "/product/review/:id",
  userAuth.isLoggedIn,
  ProductOperations.deleteReview,
);

router.post(
  "/product-add",
  userAuth.checkAdmin,
  productMediaUpload,
  ProductOperations.CreateProduct,
  handleMulterError,
);
router.put(
  "/product-update/:id",
  userAuth.checkAdmin,
  productMediaUpload,
  ProductOperations.updateProduct,
  handleMulterError,
);
router.delete(
  "/product/:id",
  userAuth.checkAdmin,
  ProductOperations.deleteProduct,
);

router.get(
  "/product-delete/:id",
  userAuth.checkAdmin,
  ProductOperations.deleteProduct,
); // deprecated: use DELETE /product/:id

export default router;
