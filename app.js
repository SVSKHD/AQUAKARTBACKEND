import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
// routes
import userRoutes from "./src/routes/user.js";
import categoryRoutes from "./src/routes/category.js"
import subCategoryRoutes from "./src/routes/sub-category.js"

dotenv.config(); // Load environment variables

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(morgan("dev"));


app.get("/v1", (req, res) => {
  res.json({ status: "Hello Aquakart v1" });
});

app.use("/v1", userRoutes);
app.use("/v1", categoryRoutes)
app.use("/v1", subCategoryRoutes)

export default app;
