import "./config.js";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import swaggerUi from "swagger-ui-express";
import { promises as fs } from "fs";
import path from "path";
import userRoutes from "./src/routes/user.js";
import googleAuthRoutes from "./src/routes/googleAuth.js";
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
import SoftenerHydRoutes from "./src/routes/SoftenersHyd.js";
import metaWhatsAppWebhookRoutes from "./src/routes/whatsappMetaWebhook.js";
import invoiceRoutes from "./src/routes/crm/invoice.js";
import publicInvoiceRoutes from "./src/routes/publicInvoice.js";
import paymentLinkRoutes from "./src/routes/crm/paymentLink.js";
import AdminUserRoutes from "./src/routes/crm/adminUser.js";
import AdminCategoryRoutes from "./src/routes/crm/category.js";
import AquaStock from "./src/routes/crm/stock.js";
import AdminCustomerRoutes from "./src/routes/crm/customer.js";
import CustomerProfileRoutes from "./src/routes/crm/customerProfile.js";
import AdminQuotationRoutes from "./src/routes/crm/quotation.js";
import CRMOrderRoutes from "./src/routes/crm/order.js";
import CRMEcommerceOrderRoutes from "./src/routes/crm/ecommerceOrders.js";
import WhatsappOperations from "./src/controllers/sendWhatsapp.js";

const app = express();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const BASE = process.env.WHATSAPPAPI;
const KEY = process.env.WHATSAPPAPIKEY;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://admin.aquakart.co.in",
    "https://aquakart.co.in",
    "https://www.aquakart.co.in",
    "http://localhost:4000",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));
app.use(morgan("tiny"));

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

app.use("/v1/whatsapp/webhook/meta", metaWhatsAppWebhookRoutes);

app.use("/v1", googleAuthRoutes);
app.use("/v1", userRoutes);
app.use("/v1", categoryRoutes);
app.use("/v1", subCategoryRoutes);
app.use("/v1", productRoutes);
app.use("/v1", blogRoutes);
app.use("/v1", phonePeGatewayRoutes);
app.use("/v1", orderRoutes);
app.use("/v1", Coupons);
app.use("/v1", SoftenerHydRoutes);
app.use("/v1/notify", SendWhatsAppMessage);
app.use("/v1/email", SendEmail);
app.use("/v1/subscription", Subscritions);

app.use("/v1/crm", invoiceRoutes);
app.use("/v1/invoices/public", publicInvoiceRoutes);
app.use("/v1/crm", paymentLinkRoutes);
app.use("/v1/crm", AquaStock);
app.use("/v1/crm/user", AdminUserRoutes);
app.use("/v1/crm/customers", AdminCustomerRoutes);
app.use("/v1/crm/customer-profiles", CustomerProfileRoutes);
app.use("/v1/crm/quotations", AdminQuotationRoutes);
app.use("/v1/crm/orders", CRMOrderRoutes);
app.use("/v1/crm/ecom-orders", CRMEcommerceOrderRoutes);

app.post(
  "/v1/notify/send-whatsappp",
  WhatsappOperations.sendWhatsAppPostMethod,
);

const swaggerSetup = async () => {
  try {
    const swaggerPath = path.resolve("./swagger-output.json");
    const swaggerData = await fs.readFile(swaggerPath, "utf8");
    const swaggerDocument = JSON.parse(swaggerData);

    app.use("/v1/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  } catch (error) {
    console.error("Error loading Swagger JSON:", error);
  }
};

swaggerSetup();

export default app;
