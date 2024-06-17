import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
// routes
import userRoutes from "./src/routes/user.js";
import categoryRoutes from "./src/routes/category.js";
import subCategoryRoutes from "./src/routes/sub-category.js";
import productRoutes from "./src/routes/product.js";
import blogRoutes from "./src/routes/blog.js";
import phonePeGatewayRoutes from "./src/routes/phonepegatway.js";
// crm route imports
import invoiceRoutes from "./src/routes/crm/invoice.js";

dotenv.config(); // Load environment variables

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(cors());
app.use(morgan("dev"));

app.get("/v1", (req, res) => {
  res.json({ status: "Hello Aquakart v1" });
});
// ecom routes
app.use("/v1", userRoutes);
app.use("/v1", categoryRoutes);
app.use("/v1", subCategoryRoutes);
app.use("/v1", productRoutes);
app.use("/v1", blogRoutes);
app.use("/v1", phonePeGatewayRoutes);
// crm routes
app.use("/v1/crm", invoiceRoutes);
//get all users for admin
//get all orders
//get ecom status
//get activities (user login and all the events performed by user)
// crud update all the products categories sub categories

export default app;
