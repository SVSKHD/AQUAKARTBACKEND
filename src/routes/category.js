import express from "express";
import CategoryOperations from "../controllers/category.js";
import userAuth from "../middleware/user.js";
import multer from "multer";

const router = express.Router();

const storage = multer.memoryStorage(); // Use memory storage or disk storage based on your requirement
const upload = multer({ storage });

router.get("/category-status", (req, res) => {
  res.json({ message: "Category Status v1 active" });
});

router.get("/allcategories", CategoryOperations.getAllCategories);
router.get("/category/:id", CategoryOperations.getCategory);
router.get("/category-title/:title", CategoryOperations.getCategoryByTitle);
router.get("/category-remove/:id", CategoryOperations.deleteCategory);

router.post(
  "/category-add",
  userAuth.checkAdmin,
  upload.array("photos"),
  CategoryOperations.addCategory,
);

router.put(
  "/category-update",
  userAuth.checkAdmin,
  upload.array("photos"),
  CategoryOperations.updateCategory,
);

router.get(
  "/category/delete/:id",
  userAuth.checkAdmin,
  CategoryOperations.deleteCategory,
);

export default router;
