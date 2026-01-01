import axios from "axios";

const BASE = "https://app.whatsera.com";
const KEY = "685e311c3d3aacf917650e6f";

const sendWhatsAppMessage = async (no, message) => {
  try {
    const response = await axios.post(`${BASE}/api/send/text`, {
      accessToken: "685e311c3d3aacf917650e6f",
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
