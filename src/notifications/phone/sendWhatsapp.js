import axios from "axios";

const BASE = process.env.WHATSAPPAPI;
const KEY = process.env.WHATSAPPAPIKEY;
const sendWhatsAppMessage = async (no, message) => {
  try {
    const response = await axios.post(`${BASE}/api/send/text`, {
      accessToken: KEY,
      mobile: `91${no}`,
      text: message || "Aquakart Welcomes you",
    });

    if (response.data.success) {
      return { status: true, message: "Message sent successfully" };
    } else {
      throw {
        status: false,
        error: response.data.error || "Failed to send message",
      };
    }
  } catch (error) {
    console.error(
      "Error:",
      error.response ? error.response.data : error.message,
    );
    throw {
      status: false,
      error: error.response ? error.response.data : error.message,
    };
  }
};

export default sendWhatsAppMessage;
