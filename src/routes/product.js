import express from "express";
import ProductOperations from "../controllers/product.js";
import userAuth from "../middleware/user.js";
const router = express.Router();

router.get("/product-status", (req, res) => {
  res.json({ message: "product status v1 active" });
});
router.get("/all-products", ProductOperations.getProducts);
router.get("/product/:id", ProductOperations.getProduct);
router.get("/product-title/:title", ProductOperations.getProductByTitle);
router.get("/products/:count", ProductOperations.getLimitedProducts);
router.get("/product", ProductOperations.getProductByQuery)
router.post("/product-add", ProductOperations.CreateProduct);
router.put(
  "/product-update/:id",
  userAuth.checkAdmin,
  ProductOperations.updateProduct,
);
router.get(
  "/product-delete/:id",
  userAuth.checkAdmin,
  ProductOperations.deleteProduct,
);

export default router;
