import nodemailer from "nodemailer";

async function sendEmail({ email, subject, message, content }) {
  // Configure the transporter with Hostinger SMTP settings
  const transporter = nodemailer.createTransport({
    host: "smtp.hostinger.com", // SMTP host for Hostinger
    port: 465, // SMTP port for SSL
    secure: true, // Use SSL
    auth: {
      user: process.env.SMTPEMAIL, // Your email address
      pass: process.env.SMTPEMAILPASSWORD, // Your email password
    },
  });

  try {
    const info = await transporter.sendMail({
      from: `"AquaKart Support" <customercare@aquakart.co.in>`, // Sender details
      to: email, // Recipient email
      subject: subject, // Email subject
      text: message, // Plain text version of the message
      html: content, // HTML version of the message
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
