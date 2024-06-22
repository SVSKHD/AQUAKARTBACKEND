import express from "express";
import CategoryOperations from "../controllers/category.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/category-status", (req, res) => {
  res.json({ message: "Category Status v1 active" });
});

router.get("/allcategories", CategoryOperations.getAllCategories);
router.get("/category/:id", CategoryOperations.getCategory);
router.get("/category/title/:title",CategoryOperations.getCategoryByTitle)
router.get("/category-remove/:id", CategoryOperations.deleteCategory);
router.post(
  "/category-add",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  CategoryOperations.addCategory,
);
router.put(
  "/category-update",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  CategoryOperations.updateCategory,
);
router.get(
  "/category/delete/:id",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  CategoryOperations.deleteCategory,
);
export default router;
