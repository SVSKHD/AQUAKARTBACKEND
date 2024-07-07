import AquaBlog from "../models/blog.js";
import cloudinary from "cloudinary";
import AquaProduct from "../models/product.js"


const BlogAdd = async (req, res) => {};
const getBlogs = async (req, res) => {
  try {
    const blogs = await AquaBlog.find({});
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
    return res.status(200).json({ success: true, data: blogById });
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, message: "sorry we couldn't fetch blog id" });
  }
};
const BlogUpdate = async (req, res) => {};
const BlogOperations = {
  BlogAdd,
  BlogUpdate,
  getBlogs,
  getBlogById,
};
export default BlogOperations;
