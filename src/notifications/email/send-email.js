import nodemailer from "nodemailer";

async function sendEmail({ email, subject, message, content }) {
  const transporter = nodemailer.createTransport({
    host: "smtp.hostinger.com",
    port: 465, // ✅ STARTTLS port
    secure: true, // ✅ false for 587, Nodemailer will STARTTLS
    auth: {
      user: "customercare@aquakart.co.in",
      pass: "Hithesh.svsk123",
    },
    logger: true, // optional: verbose logs in container
    debug: true, // optional: verbose logs in container
  });

  try {
    const info = await transporter.sendMail({
      from: `"AquaKart Support" <customercare@aquakart.co.in>`,
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
      code: error.code,
      message: error.message,
      command: error.command,
    });

    return {
      success: false,
      message: "Failed to Send Email",
      error: error.message,
      code: error.code,
    };
  }
}

export default sendEmail;
