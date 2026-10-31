import mongoose from "mongoose";

// Resolves true once connected, false if the connection failed.
const mongooseConnect = (url) =>
  mongoose
    .connect(url)
    .then(() => {
      console.log("Connected to MongoDB");
      return true;
    })
    .catch((error) => {
      console.log(error);
      return false;
    });

export default mongooseConnect;
