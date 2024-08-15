const subscriptionEmail = (email) => {
  return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <title>Subscription Confirmed</title>
          <style>
            body {
              font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
              margin: 0;
              padding: 0;
              -webkit-text-size-adjust: none;
              -ms-text-size-adjust: none;
              background-color: #f4f4f4;
            }
            .email-container {
              width: 100%;
              margin: auto;
              padding: 20px;
              background: #ffffff;
              box-shadow: 0px 0px 10px rgba(0,0,0,0.1);
            }
            .header-img {
              height: 80px;
              margin-bottom: 20px;
            }
            h1 {
              color: #333;
            }
            p {
              font-size: 16px;
              color: #555;
            }
            a {
              color: #3498db;
              text-decoration: none;
            }
          </style>
        </head>
        <body>
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center">
            <tr>
              <td align="center">
                <table class="email-container" role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                  <tr>
                    <td align="center">
                      <img src="https://res.cloudinary.com/aquakartproducts/image/upload/v1695408027/android-chrome-384x384_ijvo24.png" alt="Aquakart" class="header-img"/>
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <h1>Welcome to AquaKart!</h1>
                      <p>Hi there,</p>
                      <p>Thank you for subscribing to AquaKart. We're excited to have you on board!</p>
                      <p>You'll be the first to know about exclusive deals, new product launches, and much more.</p>
                      <p>If you ever have any questions, feel free to reply to this email or visit our <a href="https://aquakart.co.in/">website</a>.</p>
                      <hr>
                      <p>We appreciate your support!</p>
                      <p>Your registered email: <strong>${email}</strong></p>
                      <p>Best regards,<br/>The AquaKart Team</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
};

export default subscriptionEmail;
