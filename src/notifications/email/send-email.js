import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.hostinger.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTPEMAIL,
    pass: process.env.SMTPEMAILPASSWORD,
  },
});

async function sendEmail({ email, subject, message, content }) {
  try {
    if (!process.env.SMTPEMAIL || !process.env.SMTPEMAILPASSWORD) {
      throw new Error("SMTP credentials are not configured");
    }

    const info = await transporter.sendMail({
      from: `"AquaKart Support" <${process.env.SMTPEMAIL}>`,
      to: email,
      subject,
      text: message,
      html: content,
    });

    return {
      success: true,
      message: "Email Sent Successfully",
      messageId: info.messageId,
    };
  } catch (error) {
    console.error("Failed to send email:", {
      message: error.message,
      code: error.code,
      command: error.command,
      response: error.response,
    });

    return {
      success: false,
      message: "Failed to Send Email",
      error: error.message,
      code: error.code || null,
    };
  }
}

export default sendEmail;
