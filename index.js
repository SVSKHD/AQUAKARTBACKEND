// Load environment variables first (.env or Doppler). Only DB_URL and
// AQUA_ENV_ENCRYPTION_KEY need to live there; everything else comes from the
// "aqua-env" collection, managed in the CRM.
import "./config.js";

import mongooseConnect from "./src/utils/db.js";
import { aquaEnvStore } from "./src/services/aquaEnv.js";

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

// Connect before importing the app: many modules read process.env when they
// are first imported, so the stored configuration must be in place by then.
const connected = await mongooseConnect(process.env.DB_URL);
if (connected) {
  try {
    const summary = await aquaEnvStore.load();
    console.log(
      `aqua-env: loaded ${summary.loaded.length} of ${summary.total} variables`,
    );
    if (summary.failed.length)
      console.error(
        `aqua-env: could not load ${summary.failed.join(", ")}${summary.error ? ` (${summary.error})` : ""}; using server environment values for these`,
      );
    if (summary.skipped.length)
      console.warn(
        `aqua-env: ignored reserved variables ${summary.skipped.join(", ")}`,
      );
  } catch (error) {
    console.error(
      "aqua-env: could not read stored configuration; using server environment only:",
      error.message,
    );
  }
} else {
  console.error(
    "MongoDB is unreachable; starting with server environment values only.",
  );
}

const [
  { default: cloudinary },
  { default: app },
  { default: UserRole },
  { default: generateSwaggerDocs },
  { startScheduler },
  { isTestingMode },
  { mcpServices },
  { startInstagramCleanupWorker },
] = await Promise.all([
  import("cloudinary"),
  import("./app.js"),
  import("./src/models/userRole.js"),
  import("./swagger-autogen.js"),
  import("./src/services/scheduler/index.js"),
  import("./src/services/aiQuota.js"),
  import("./src/routes/mcp.js"),
  import("./src/services/mcp/index.js"),
]);

const PORT = process.env.PORT || 5300;

// Make sure the storefront roles (admin, tester, user) exist.
if (connected) {
  try {
    const roles = await UserRole.ensureDefaults();
    console.log(`User roles: ${roles.map((r) => r.slug).join(", ")}`);
  } catch (error) {
    console.error("Could not create the default user roles:", error);
  }
}
// Runs the built-in reminder jobs and any jobs created from the CRM.
startScheduler();
// Deletes temporary Instagram images after verified publication (no-op
// unless MCP and Instagram are configured).
startInstagramCleanupWorker(mcpServices);
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
