import mongoose from "mongoose";

const softenersHydSchema = new mongoose.Schema({
  title: {
    type: String,
  },
  description: {
    type: String,
  },
  keywords: {
    type: String,
  },
  area: {
    type: String,
  },
  photos: [
    {
      id: {
        type: String,
        required: true,
      },
      secure_url: {
        type: String,
        required: true,
      },
    },
  ],
});

const AquaSoftenersHyd =
  mongoose.models.AquaSoftenersHyd ||
  mongoose.model("AquaSoftenersHyd", softenersHydSchema);

export default AquaSoftenersHyd;
