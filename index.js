// Load environment variables first
import "./config.js";

import cloudinary from "cloudinary";
import app from "./app.js";
import mongooseConnect from "./src/utils/db.js";
import generateSwaggerDocs from "./swagger-autogen.js";
import { startScheduler } from "./src/services/scheduler/index.js";
import { isTestingMode } from "./src/services/aiQuota.js";

const PORT = process.env.PORT || 5300; // Default to port 3000 if PORT is not set

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

mongooseConnect(process.env.DB_URL);
// Runs the built-in reminder jobs and any jobs created from the CRM.
startScheduler();
if (isTestingMode()) {
  console.warn(
    "TESTING_MODE is on: storefront AI daily question limits are disabled.",
  );
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

generateSwaggerDocs().catch((error) => {
  console.error("Error generating Swagger documentation:", error);
});
