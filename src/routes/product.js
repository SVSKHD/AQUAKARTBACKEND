import express from "express";
import ProductOperations from "../controllers/product.js";
import userAuth from "../middleware/user.js";
const router = express.Router();

router.get("/product-status", (req, res) => {
  res.json({ message: "product status v1 active" });
});
router.get("/all-products", ProductOperations.getProducts);
router.get("/product/:id", ProductOperations.getProduct);

export default router;
