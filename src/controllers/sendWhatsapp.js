import axios from "axios";

const BASE = "https://app.whatsera.com";
const KEY = "685e311c3d3aacf917650e6f";

const sendMessage = async (req, res) => {
  const { no } = req.params;
  const { message } = req.query;

  try {
    const response = await axios.post(`${BASE}/api/send/text`, {
      accessToken: KEY,
      mobile: `91${no}`,
      text: message || "Aquakart Welcomes you",
    });

    console.log("Response:", response.data);

    if (response.data.success) {
      res.status(200).json({ message: "Message sent successfully" });
    } else {
      res
        .status(400)
        .json({ message: response.data || "Failed to send message" });
    }
  } catch (error) {
    console.error("Error:", error.response ? error.response : error.message);
    res
      .status(400)
      .json({ message: error.response ? error.response : error.message });
  }
};

const sendWhatsAppPostMethod = async (req, res) => {
  const { no, message } = req.body;

  try {
    const response = await axios.post(`${BASE}/api/send/text`, {
      accessToken: KEY,
      mobile: `91${no}`,
      text: message || "Aquakart Welcomes you",
    });

    console.log("Response:", response.data);

    if (response.data.success) {
      res
        .status(200)
        .json({ status: true, message: "Message sent successfully" });
    } else {
      res
        .status(400)
        .json({ message: response.data.error || "Failed to send message" });
    }
  } catch (error) {
    console.error(
      "Error:",
      error.response ? error.response.data : error.message,
    );
    res
      .status(400)
      .json({ message: error.response ? error.response.data : error.message });
  }
};

const WhatsappOperations = {
  sendMessage,
  sendWhatsAppPostMethod,
};

export default WhatsappOperations;
