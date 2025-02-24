import express from "express";
import ProductOperations from "../controllers/product.js";
import userAuth from "../middleware/user.js";

import multer from "multer";

const router = express.Router();
const storage = multer.memoryStorage(); // Use memory storage or disk storage based on your requirement
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

router.get("/product-status", (req, res) => {
  res.json({ message: "product status v1 active" });
});
router.get("/all-products", ProductOperations.getProducts);
router.get("/product/:id", ProductOperations.getProduct);
router.get("/product-title/:title", ProductOperations.getProductByTitle);
router.get("/products/:count", ProductOperations.getLimitedProducts);
router.get("/product", ProductOperations.getProductByQuery);

router.post(
  "/product-add",
  userAuth.checkAdmin,
  upload.fields([
    { name: "photos", maxCount: 10 }, // Accept up to 10 photos
    { name: "ar", maxCount: 5 }, // Accept up to 5 AR files
  ]),
  ProductOperations.CreateProduct,
);
router.put(
  "/product-update/:id",
  userAuth.checkAdmin,
  upload.fields([
    { name: "photos", maxCount: 10 }, // Accept up to 10 photos
    { name: "ar", maxCount: 5 }, // Accept up to 5 AR files
  ]),
  ProductOperations.updateProduct,
);
router.get(
  "/product-delete/:id",
  userAuth.checkAdmin,
  ProductOperations.deleteProduct,
);

export default router;
