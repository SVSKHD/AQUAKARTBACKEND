import nodemailer from "nodemailer";

async function sendEmail({ email, subject, message, content }) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "aquakart8@gmail.com",
      pass: "vpyzejrvgbhkjdbe",
    },
  });

  try {
    const info = await transporter.sendMail({
      from: `"AquaKart" aquakart8@gmail.com`,
      to: email,
      subject: subject,
      text: message,
      html: content,
    });
    return {
      success: true,
      message: "Email Sent Successfully",
      messageId: info.messageId,
    };
  } catch (error) {
    console.error("Failed to send email:", error);
    return {
      success: false,
      message: "Failed to Send Email",
      error: error.message,
    };
  }
}

export default sendEmail;
