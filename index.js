import app from "./app.js";
import mongooseConnect from "./src/utils/db.js";

const PORT = process.env.PORT || 3000; // Default to port 3000 if PORT is not set

mongooseConnect(process.env.DB_URL);
// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
