import nodemailer from "nodemailer";

async function sendEmail({ email, subject, message, content }) {
  const requiredConfig = [
    process.env.SMTP_HOST,
    process.env.SMTP_USER,
    process.env.SMTP_PASSWORD,
  ];
  if (requiredConfig.some((value) => !value)) {
    return {
      success: false,
      message: "Email delivery is not configured",
      code: "EMAIL_NOT_CONFIGURED",
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  try {
    const info = await transporter.sendMail({
      from:
        process.env.EMAIL_FROM ||
        `"Aquakart Support" <${process.env.SMTP_USER}>`,
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
