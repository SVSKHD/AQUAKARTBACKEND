// Load environment variables first
import "./config.js";

import app from "./app.js";
import mongooseConnect from "./src/utils/db.js";
import cloudinary from "cloudinary";

const PORT = process.env.PORT || 3000; // Default to port 3000 if PORT is not set

mongooseConnect(process.env.DB_URL);
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
