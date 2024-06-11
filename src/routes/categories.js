import express from "express";
import categoryFunctions from "../controllers/category";
import userAuth from "../middleware/user";

const router = express.Router();

router.get("/category-status", (req, res) => {
  res.json({ message: "Category Status v1 active" });
});

router.get("/allcategories", categoryFunctions().getAllCategories);
router.get("/category/:id", categoryFunctions().getCategory);
router.get("/category-remove/:id", categoryFunctions().deleteCategory);
router.post("/category-add", categoryFunctions().addCategory);
router.put(
  "/category-update",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  categoryFunctions().updateCategory,
);
export default router;
