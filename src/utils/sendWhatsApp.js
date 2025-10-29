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
    console.log("response", response);
    if (response.data.success) {
      return { success: true, message: "Message sent successfully" };
    } else {
      return { success: false, message: "Failed to send message" };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
};

export default sendWhatsAppMessage;
