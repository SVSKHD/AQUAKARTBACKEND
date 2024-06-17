import express from "express";
import SubCategoryOperations from "../controllers/sub-category.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/subcategory-status", (req, res) => {
  res.json({ message: "Subcategory status v1 active" });
});
router.get("/all-subcategories", SubCategoryOperations.getAllSubCategories);
router.get("/subcategory/:id", SubCategoryOperations.getSubCategory);
router.post(
  "/subcategory-add",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  SubCategoryOperations.addSubCategory,
);
router.post(
  "/subcategory-update",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  SubCategoryOperations.updateSubCategory,
);
router.get(
  "/subcategory/delete/:id",
  userAuth.isLoggedIn,
  userAuth.checkAdmin,
  SubCategoryOperations.deleteSubCategory,
);

export default router;
