import "./config.js";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import { promises as fs } from "fs"; // Importing fs promises API to read files asynchronously
import path from "path"; // For resolving file paths
import axios from "axios"
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
import Subscritions from "./src/routes/subscribe.js";
import Coupons from "./src/routes/coupon.js";
// crm route imports
import invoiceRoutes from "./src/routes/crm/invoice.js";
import paymentLinkRoutes from "./src/routes/crm/paymentLink.js";
import AdminUserRoutes from "./src/routes/crm/adminUser.js";
import AdminCategoryRoutes from "./src/routes/crm/category.js";

//methods
import WhatsappOperations from "./src/controllers/sendWhatsapp.js";

const app = express();
// app.use(
//   fileUpload({
//     useTempFiles: true, // Use temp files for larger file uploads
//     tempFileDir: "/tmp/", // Temp directory for file uploads
//     limits: { fileSize: 2 * 1024 * 1024 }, // 2MB file size limit
//   })
// );

// Multer Configuration
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
});

const BASE = process.env.WHATSAPPAPI;
const KEY = process.env.WHATSAPPAPIKEY;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// CORS configuration
const corsOptions = {
  origin: ["http://localhost:3000", "https://admin.aquakart.co.in", "https://aquakart.co.in","http://localhost:4000"],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.use(morgan("tiny"));

// Routes
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
app.use("/v1", productRoutes);
app.use("/v1", blogRoutes);
app.use("/v1", phonePeGatewayRoutes);
app.use("/v1", orderRoutes);
app.use("/v1", Coupons);  
app.use("/v1/notify", SendWhatsAppMessage);
app.use("/v1/email", SendEmail);
app.use("/v1/subscription", Subscritions);

// crm routes
app.use("/v1/crm", invoiceRoutes);
app.use("/v1/crm", paymentLinkRoutes);
app.use("/v1/crm/user", AdminUserRoutes);


app.post("/v1/notify/send-whatsappp",WhatsappOperations.sendWhatsAppPostMethod)

// Load the Swagger JSON dynamically using fs and path
const swaggerSetup = async () => {
  try {
    const swaggerPath = path.resolve("./swagger-output.json"); // Resolve the JSON file path
    const swaggerData = await fs.readFile(swaggerPath, "utf8"); // Read the JSON file as a string
    const swaggerDocument = JSON.parse(swaggerData); // Parse the string to JSON

    // Setup Swagger UI
    app.use("/v1/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  } catch (error) {
    console.error("Error loading Swagger JSON:", error);
  }
};

swaggerSetup(); // Setup Swagger UI with the JSON file

export default app;
