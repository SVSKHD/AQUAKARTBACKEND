import express from "express";
import BlogOperations from "../controllers/blog.js";
import userAuth from "../middleware/user.js";
import multer from "multer";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Limit file size to 5MB
});

router.get("/blog-status", (req, res) => {
  res.json({ message: "blog status v1 active" });
});
router.get("/all-blogs", BlogOperations.getBlogs);
router.get("/blog/:id", BlogOperations.getBlogById);
router.post(
  "/blog-add",
  userAuth.checkAdmin,
  upload.fields([
    { name: "photos", maxCount: 10 },
    { name: "titleImages", maxCount: 2 },
  ]),
  BlogOperations.BlogAdd,
);
router.post("/blog-update/:id", userAuth.checkAdmin);
router.get("/delete/blog/:id", userAuth.checkAdmin);

export default router;
