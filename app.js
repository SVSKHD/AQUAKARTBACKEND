// Load environment variables first
import './config.js';

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";

// routes
import userRoutes from "./src/routes/user.js";
import categoryRoutes from "./src/routes/category.js";
import subCategoryRoutes from "./src/routes/sub-category.js";
import productRoutes from "./src/routes/product.js";
import blogRoutes from "./src/routes/blog.js";
import phonePeGatewayRoutes from "./src/routes/phonepegatway.js";
import orderRoutes from "./src/routes/orders.js";
import SendWhatsAppMessage from "./src/routes/sendWhatsppMessage.js";
import SendEmail from "./src/routes/sendEmail.js";
// crm route imports
import invoiceRoutes from "./src/routes/crm/invoice.js";
import paymentLinkRoutes from "./src/routes/crm/paymentLink.js";
import AdminUserRoutes from "./src/routes/crm/adminUser.js";
import AdminCategoryRoutes from "./src/routes/crm/category.js";

const app = express();

// Middleware for parsing JSON and urlencoded form data
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb', parameterLimit: 10000 }));
app.use(cors());
app.use(morgan("dev"));

// Multer setup for multipart/form-data (e.g., file uploads)
const upload = multer();
app.use(upload.any());

// Middleware to make form data accessible across routes
app.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    req.formData = req.body;
  }
  next();
});

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
app.use("/v1", orderRoutes);
app.use("/v1/notify", SendWhatsAppMessage);
app.use("/v1/email", SendEmail);

// crm routes
app.use("/v1/crm", invoiceRoutes);
app.use("/v1/crm", paymentLinkRoutes);
app.use("/v1/crm/user", AdminUserRoutes);
// app.use("/v1/crm", AdminCategoryRoutes); // Uncomment if needed

export default app;