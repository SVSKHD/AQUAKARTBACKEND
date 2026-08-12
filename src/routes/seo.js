import express from "express";
import { getPublicSeo } from "../controllers/seo.js";

const router = express.Router();

router.get("/public/:pageKey", getPublicSeo);

export default router;
