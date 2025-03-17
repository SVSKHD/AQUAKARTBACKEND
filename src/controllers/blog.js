import AquaBlog from "../models/blog.js";
import cloudinary from "cloudinary";
import AquaProduct from "../models/product.js";

const streamUpload = (buffer) => {
  return new Promise((resolve, reject) => {
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
};

const BlogAdd = async (req, res, next) => {
  console.log("req.files", req.files);
  const photos = req?.files?.photos;
  const titleImages = req?.files?.titleImages;
  let imageArray = [];
  let titleImageArray = [];
  if (!photos || !titleImages) {
    return res.status(400).json({ message: "Please upload images" });
  }
  if (photos.length > 10) {
    return res.status(400).json({ message: "Maximum of 10 images allowed" });
  }
  if (titleImages.length > 1) {
    return res
      .status(400)
      .json({ message: "Maximum of 1 title image allowed" });
  }
  if (titleImages.length > 1) {
    return res
      .status(400)
      .json({ message: "Maximum of 1 title image allowed" });
  }

  console.log("photos", photos, titleImages);

  if (photos.length > 0) {
    for (const photo of photos) {
      if (!photo.buffer) {
        return next(new Error("File buffer is missing", 400));
      }
      const result = await streamUpload(photo.buffer);
      imageArray.push({
        id: result.public_id,
        secure_url: result.secure_url,
      });
    }
  }

  if (titleImages.length > 0) {
    for (const photo of titleImages) {
      if (!photo.buffer) {
        return next(new Error("File buffer is missing", 400));
      }
      const result = await streamUpload(photo.buffer);
      titleImageArray.push({
        id: result.public_id,
        secure_url: result.secure_url,
      });
    }
  }

  req.body.photos = imageArray;
  req.body.titleImages = titleImageArray;

  const blog = await AquaBlog.create(req.body);
  res.status(200).json({ success: true, data: blog });
};
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
const BlogUpdate = async (req, res) => {};
const BlogOperations = {
  BlogAdd,
  BlogUpdate,
  getBlogs,
  getBlogById,
};
export default BlogOperations;
