import mongoose from "mongoose";

const mongooseConnect = (url) =>
  mongoose
    .connect(url)
    .then((connection) => {
      console.log("Connected to MongoDB");
      return connection;
    })
    .catch((error) => {
      console.log(error);
      throw error;
    });

export default mongooseConnect;
