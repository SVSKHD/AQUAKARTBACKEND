import mongoose from "mongoose";

// Mongoose doesn't retry a failed first connection (e.g. a transient DNS
// "querySrv ESERVFAIL" on the Atlas SRV lookup), so retry it here.
const MAX_ATTEMPTS = 10;
const RETRY_MS = 15 * 1000;

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Resolves true once connected, false if every attempt failed.
const mongooseConnect = async (url) => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await mongoose.connect(url);
      console.log("Connected to MongoDB");
      return true;
    } catch (error) {
      console.error(
        `MongoDB connection failed (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        error.message,
      );
      if (attempt < MAX_ATTEMPTS) await wait(RETRY_MS);
    }
  }
  return false;
};

export default mongooseConnect;
