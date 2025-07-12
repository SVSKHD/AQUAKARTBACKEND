import AquaSoftenersHyd from "../models/softenersHyd.js";
import cloudinary from "cloudinary";

const streamUpload = (buffer) => {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.v2.uploader.upload_stream(
      { folder: "Hyderabadsofteners" },
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

const deleteMedia = async (mediaArray) => {
  try {
    for (const media of mediaArray) {
      await cloudinary.v2.uploader.destroy(media.id);
    }
  } catch (error) {
    console.error("Error deleting media:", error);
    throw new Error("Failed to delete old media");
  }
};

const createSoftenersHyd = async (req, res, next) => {
  const photos = req.files?.photos;
  if (!photos || photos.length === 0) {
    return next(new Error("Images are required", 401));
  }
  let imageArray = [];
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
  req.body.photos = imageArray;
  const softenersImages = await AquaSoftenersHyd.create(req.body);
  res.status(200).json(softenersImages);
};

const getSoftenersHyd = async (req, res) => {
  const softenersImages = await AquaSoftenersHyd.find();
  if (!softenersImages) {
    return res.status(404).json({ message: "No softeners found" });
  }
  res.status(200).json(softenersImages);
};

const SoftenerHydOperations = {
  createSoftenersHyd,
  getSoftenersHyd,
};

export default SoftenerHydOperations;
