import sendEmail from "../notifications/email/send-email.js";

const SendEmail = async (req, res) => {
  const { email, subject, message, content } = req.body;

  if (!email || !subject || !message || !content) {
    return res.status(400).json({
      success: false,
      message: "All fields are required: email, subject, message, content",
    });
  }

  try {
    const emailResponse = await sendEmail({ email, subject, message, content });

    if (emailResponse.success) {
      return res.status(200).json(emailResponse);
    } else {
      return res.status(500).json(emailResponse);
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

export default SendEmail;
