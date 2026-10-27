import express from "express";
import multer from "multer";
import BlogOperations, { STAFF_BLOG_STATUSES } from "../controllers/blog.js";
import userAuth from "../middleware/user.js";

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // Limit file size to 5MB
});

router.get("/blog-status", (req, res) => {
  res.json({ message: "blog status v1 active" });
});
// Listing drafts (?status=draft|all) is staff-only.
const blogStatusAccess = (req, res, next) =>
  STAFF_BLOG_STATUSES.includes(req.query.status)
    ? userAuth.checkAdmin(req, res, next)
    : next();

router.get("/all-blogs", blogStatusAccess, BlogOperations.getBlogs);
router.get("/blog/:id", blogStatusAccess, BlogOperations.getBlogById);
router.get("/blog/:title", BlogOperations.getBlogByTitle);
router.get("/blog-slug/:slug", BlogOperations.getBlogBySlug);
router.post(
  "/blog-add",
  userAuth.checkAdmin,
  upload.fields([
    { name: "photos", maxCount: 10 },
    { name: "titleImages", maxCount: 2 },
  ]),
  BlogOperations.BlogAdd,
);
const blogMedia = upload.fields([
  { name: "photos", maxCount: 10 },
  { name: "titleImages", maxCount: 1 },
]);
router.put(
  "/blog-update/:id",
  userAuth.checkAdmin,
  blogMedia,
  BlogOperations.updateBlog,
);
router.delete(
  "/delete/blog/:id",
  userAuth.checkAdmin,
  BlogOperations.deleteBlog,
);

// CRM aliases retained so both deployed clients use the same CRUD contract.
router.post(
  "/add-blog",
  userAuth.checkAdmin,
  blogMedia,
  BlogOperations.BlogAdd,
);
router.put(
  "/update-blog/:id",
  userAuth.checkAdmin,
  blogMedia,
  BlogOperations.updateBlog,
);
router.delete(
  "/delete-blog/:id",
  userAuth.checkAdmin,
  BlogOperations.deleteBlog,
);

export default router;
