// Load environment variables first
import './config.js';

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import morgan from "morgan";

// routes
import userRoutes from "./src/routes/user.js";
import categoryRoutes from "./src/routes/category.js";
import subCategoryRoutes from "./src/routes/sub-category.js";
import productRoutes from "./src/routes/product.js";
import blogRoutes from "./src/routes/blog.js";
import phonePeGatewayRoutes from "./src/routes/phonepegatway.js";
import orderRoutes from "./src/routes/orders.js"
import SendWhatsAppMessage from "./src/routes/sendWhatsppMessage.js";
// crm route imports
import invoiceRoutes from "./src/routes/crm/invoice.js";
import paymentLinkRoutes from "./src/routes/crm/paymentLink.js";
import AdminUserRoutes from "./src/routes/crm/adminUser.js"
import AdminCategoryRoutes from "./src/routes/crm/category.js"
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
app.use("/v1", orderRoutes)
app.use("/v1/notify", SendWhatsAppMessage);

// crm routes
app.use("/v1/crm", invoiceRoutes);
app.use("/v1/crm", paymentLinkRoutes);
// app.use("/v1/crm", AdminCategoryRoutes)
app.use("/v1/crm/user" , AdminUserRoutes)
// get all users for admin
// get all orders
// get ecom status
// get activities (user login and all the events performed by user)
// crud update all the products categories sub categories

export default app;