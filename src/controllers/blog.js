import cloudinary from "cloudinary";
import AquaBlog from "../models/blog.js";
import AquaProduct from "../models/product.js";
import AquaCategory from "../models/category.js";
import AquaSubCategory from "../models/sub-category.js";

const streamUpload = (buffer) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { folder: "Blogs" },
      (error, result) => {
        if (result) {
          resolve(result);
        } else {
          reject(error);
        }
      },
    );
    stream.end(buffer);
  });

const parseMedia = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeMedia = async (value, files = [], limit = 10) => {
  const media = [];
  for (const item of parseMedia(value)) {
    const url = typeof item === "string" ? item : item?.secure_url;
    if (!url) continue;
    if (url.startsWith("data:")) {
      const uploaded = await cloudinary.v2.uploader.upload(url, {
        folder: "Blogs",
      });
      media.push({ id: uploaded.public_id, secure_url: uploaded.secure_url });
    } else {
      media.push({
        id:
          item?.id ||
          item?.public_id ||
          `external_${Date.now()}_${media.length}`,
        secure_url: url,
      });
    }
  }
  for (const file of files) {
    const uploaded = await streamUpload(file.buffer);
    media.push({ id: uploaded.public_id, secure_url: uploaded.secure_url });
  }
  return media.slice(0, limit);
};

const normalizeReference = (value) => {
  if (value === undefined) return undefined;
  if (!value) return null;
  if (typeof value === "object") return value._id || value.id || null;
  return String(value);
};

const validateTaxonomy = async ({ category, subCategory }) => {
  if (category && !(await AquaCategory.exists({ _id: category }))) {
    return "Selected category was not found";
  }
  if (subCategory) {
    const subcategory = await AquaSubCategory.findById(subCategory)
      .select("category")
      .lean();
    if (!subcategory) return "Selected subcategory was not found";
    if (!category || String(subcategory.category) !== String(category)) {
      return "Selected subcategory does not belong to the category";
    }
  }
  return "";
};

const buildBlogPayload = async (req, current = null) => {
  const category = normalizeReference(req.body.category);
  const subCategory = normalizeReference(
    req.body.subCategory ?? req.body.subcategory ?? req.body.subcategory_id,
  );
  const payload = {
    ...req.body,
    category,
    subCategory,
    product: normalizeReference(req.body.product),
  };
  delete payload.subcategory;
  delete payload.subcategory_id;
  payload.titleImages = await normalizeMedia(
    req.body.titleImages ?? current?.titleImages,
    req.files?.titleImages || [],
    1,
  );
  payload.photos = await normalizeMedia(
    req.body.photos ?? current?.photos,
    req.files?.photos || [],
    10,
  );
  return payload;
};

const BlogAdd = async (req, res, next) => {
  try {
    const payload = await buildBlogPayload(req);
    if (!payload.titleImages.length) {
      return res
        .status(400)
        .json({ success: false, message: "A title image is required" });
    }
    const taxonomyError = await validateTaxonomy(payload);
    if (taxonomyError)
      return res.status(400).json({ success: false, message: taxonomyError });
    const blog = await AquaBlog.create(payload);
    await blog.populate(["category", "subCategory", "product"]);
    return res.status(201).json({ success: true, data: blog });
  } catch (error) {
    return next(error);
  }
};
const updateBlog = async (req, res, next) => {
  try {
    const current = await AquaBlog.findById(req.params.id).lean();
    if (!current)
      return res
        .status(404)
        .json({ success: false, message: "Blog not found" });
    const payload = await buildBlogPayload(req, current);
    const taxonomyError = await validateTaxonomy(payload);
    if (taxonomyError)
      return res.status(400).json({ success: false, message: taxonomyError });
    const blog = await AquaBlog.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).populate(["category", "subCategory", "product"]);
    return res.status(200).json({ success: true, data: blog });
  } catch (error) {
    return next(error);
  }
};
const deleteBlog = async (req, res, next) => {
  try {
    const blog = await AquaBlog.findByIdAndDelete(req.params.id);
    if (!blog)
      return res
        .status(404)
        .json({ success: false, message: "Blog not found" });
    return res.status(200).json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    return next(error);
  }
};
const getBlogs = async (req, res) => {
  try {
    const blogs = await AquaBlog.find({})
      .populate("category", "_id title")
      .populate("subCategory", "_id title category")
      .populate("product", "_id title")
      .sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: blogs });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "sorry we couldn't fetch data" });
  }
};
const getBlogById = async (req, res) => {
  const { id } = req.params;
  try {
    const blogById = await AquaBlog.findById(id);
    const relatedProducts = await AquaProduct.find({
      category: blogById.category,
    });
    return res
      .status(200)
      .json({ success: true, data: blogById, relatedProduct: relatedProducts });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "sorry we couldn't fetch blog id" });
  }
};
const getBlogByTitle = async (req, res) => {
  const { title } = req.params;
  console.log("title", title);
  try {
    const blogByTitle = await AquaBlog.findOne({ title });
    return res.status(200).json({ success: true, data: blogByTitle });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: "sorry we couldn't fetch blog by title",
    });
  }
};

const getBlogBySlug = async (req, res) => {
  try {
    const slug = decodeURIComponent(req.params.slug);

    const blogBySlug = await AquaBlog.findOne({ slug });

    if (!blogBySlug) {
      return res.status(404).json({
        success: false,
        message: "Blog not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: blogBySlug,
    });
  } catch (error) {
    console.error("getBlogBySlug error:", error);

    return res.status(500).json({
      success: false,
      message: "Sorry, we couldn't fetch blog by slug",
    });
  }
};

const BlogOperations = {
  BlogAdd,
  updateBlog,
  deleteBlog,
  getBlogs,
  getBlogById,
  getBlogByTitle,
  getBlogBySlug,
};
export default BlogOperations;
