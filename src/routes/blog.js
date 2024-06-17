import express from "express";
import BlogOperations from "../controllers/blog.js";
import userAuth from "../middleware/user.js";

const router = express.Router();

router.get("/blog-status", (req, res) => {
  res.json({ message: "blog status v1 active" });
});
router.get("/all-blogs", BlogOperations.getBlogs);
router.get("/blog/:id", BlogOperations.getBlogById);
router.post("/blog-add", userAuth.checkAdmin);
router.post("/blog-update/:id", userAuth.checkAdmin);
router.get("/delete/blog/:id", userAuth.checkAdmin);

export default router;
