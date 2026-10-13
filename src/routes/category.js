import express from "express";
import multer from "multer";
import CategoryOperations from "../controllers/category.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

router.get("/category-status", (req, res) => {
  res.json({ message: "Category Status v1 active" });
});

router.get("/allcategories", CategoryOperations.getAllCategories);
router.get("/category/:id", CategoryOperations.getCategory);
router.get("/category-title/:title", CategoryOperations.getCategoryByTitle);


router.post(
  "/category-add",
  userAuth.checkAdmin,
  upload.array("photos"),
  CategoryOperations.addCategory,
);

router.put(
  "/category-update/:id",
  upload.array("photos"),
  userAuth.checkAdmin,
  CategoryOperations.updateCategory,
);
router.delete(
  "/category/delete/:id",
  userAuth.checkAdmin,
  CategoryOperations.deleteCategory,
);

export default router;
