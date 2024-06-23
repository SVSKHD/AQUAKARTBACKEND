import axios from "axios";

const BASE = process.env.WHATSAPPAPI;
const KEY = process.env.WHATSAPPAPIKEY;

const sendMessage = async (req, res) => {

  const { no } = req.params;
  const {message} = req.query
  try {
    const response = await axios.post(`${BASE}/api/send/text`, {
      accessToken: KEY,
      mobile: `91${no}`,
      text: message || "Aquakart Welcomes you"
    });

    if (response.data.success) {
      res.status(200).json({ message: "Message sent successfully" });
    } else {
      res.status(400).json({ message: "Failed to send message" });
    }
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

const WhatsappOperations = {
  sendMessage
};

export default WhatsappOperations;