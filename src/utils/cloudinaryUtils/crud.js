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




export const CloudinaryOperations = {
    deletePhoto, uploadPhoto
}