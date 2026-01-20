const deletePhoto = async (publicId) => {
  try {
    const result = await cloudinary.v2.uploader.destroy(publicId);
    console.log("Deleted photo:", result);
    return result;
  } catch (error) {
    console.error("Error deleting photo:", error);
    throw error;
  }
};

const uploadPhoto = async (filePath, publicId, folder) => {
  try {
    const result = await cloudinary.v2.uploader.upload(filePath, {
      folder: folder,
      public_id: publicId, // Use the same public_id to replace the photo
      overwrite: true, // Ensure the file is replaced
    });
    console.log("Uploaded photo:", result);
    return result;
  } catch (error) {
    console.error("Error uploading photo:", error);
    throw error;
  }
};

const cloudinaryDeliveryUrl = (url) => {
  if (!url) return url;

  if (url.includes("/image/upload/f_") || url.includes("/image/upload/q_"))
    return url;

  return url.replace("/image/upload/", "/image/upload/f_auto,q_auto/");
};

export const CloudinaryUtils = {
  deletePhoto,
  uploadPhoto,
  cloudinaryDeliveryUrl,
};
