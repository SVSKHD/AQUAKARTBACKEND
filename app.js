import "./config.js";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import fileUpload from "express-fileupload";

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  fileUpload({
    useTempFiles: true,
    tempFileDir: "/tmp/",
  }),
);

// CORS configuration
const corsOptions = {
  origin: ["http://localhost:3000", "https://aquakart.co.in"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.use(morgan("tiny"));

// Middleware to apply multer to specific routes
// const uploadMiddleware = upload.fields([{ name: 'photos' }, { name: 'arPhotos' }]);

app.get("/v1", (req, res) => {
  res.json({ status: "Hello Aquakart v1" });
});

app.get("/v1/status", (req, res) => {
  res.json({ status: "active" });
});

app.post("/v1", (req, res) => {
  const data = req.body;
  console.log("res", data);
  res.status(200).json(data);
});

// ecom routes
app.use("/v1", userRoutes);
app.use("/v1", categoryRoutes);
app.use("/v1", subCategoryRoutes);
app.use("/v1", productRoutes); // Ensure the correct path
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
