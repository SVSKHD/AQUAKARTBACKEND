import nodemailer from "nodemailer";

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    },
  });
  return transporter;
};

const getFromAddress = () => {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  const name = process.env.SMTP_FROM_NAME || "Aquakart Support";
  const email = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  return `"${String(name)
    .replace(/[\r\n"]/g, "")
    .trim()}" <${email}>`;
};

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

  try {
    const info = await getTransporter().sendMail({
      from: getFromAddress(),
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
      command: error.command,
    });

    return {
      success: false,
      message: "Failed to Send Email",
      code: error.code,
    };
  }
}

export default sendEmail;
