import express from "express";
import SubCategoryOperations from "../controllers/sub-category.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/subcategory-status", (req, res) => {
  res.json({ message: "Subcategory status v1 active" });
});
router.get("/all-subcategories", SubCategoryOperations.getAllSubCategories);
router.get("/subcategory/:id", SubCategoryOperations.getSubCategory);
router.get(
  "/subcategory-title/:title",
  SubCategoryOperations.getSubCategoryByTitle,
);
router.post(
  "/subcategory-add",
  userAuth.checkAdmin,
  SubCategoryOperations.addSubCategory,
);
// The CRM sends PUT /subcategory-update/:id (like /category-update/:id).
router.put(
  "/subcategory-update/:id",
  userAuth.checkAdmin,
  SubCategoryOperations.updateSubCategory,
);
// Legacy: id or _id in the JSON body.
router.post(
  "/subcategory-update",
  userAuth.checkAdmin,
  SubCategoryOperations.updateSubCategory,
);
router.delete(
  "/subcategory/delete/:id",
  userAuth.checkAdmin,
  SubCategoryOperations.deleteSubCategory,
);
// Path the CRM calls.
router.delete(
  "/subcategory-delete/:id",
  userAuth.checkAdmin,
  SubCategoryOperations.deleteSubCategory,
);

export default router;
