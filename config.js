// config.js
import dotenv from "dotenv";

// Only load .env when NOT using Doppler
if (!process.env.DOPPLER_PROJECT) {
  dotenv.config();
}
