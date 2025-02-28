const signupOtpTemplate = (email, username, otp) => {
  return `
          <!DOCTYPE html>
          <html lang="en">
            <head>
              <title>Welcome to Aquakart</title>
              <style>
                body {
                  font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
                  margin: 0;
                  padding: 0;
                  -webkit-text-size-adjust: none;
                  -ms-text-size-adjust: none;
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
                .content {
                  font-size: 16px;
                  margin: 20px 0;
                  padding: 10px;
                  display: inline-block;
                }
                .otp {
                  font-size: 22px;
                  margin: 20px 0;
                  padding: 10px;
                  border: 1px solid #dddddd;
                  display: inline-block;
                }
                .footer {
                  margin-top: 20px;
                  padding-top: 20px;
                  border-top: 1px solid #dddddd;
                  text-align: center;
                }
                .social-icons img {
                  margin-right: 10px;
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
                        <td align="center">
                          <h1>Welcome to AquaKart, ${username}!</h1>
                          <p>Thank you for signing up with AquaKart. We are excited to have you on board.</p>
                          <p>Your account has been successfully created with the email: <strong>${email}</strong>.</p>
                          <p>Your OTP for verification is:</p>
                          <div class="otp">${otp}</div>
                          <p>Please use this OTP to verify your email address. This OTP will expire in 1 hour.</p>
                          <div class="content">
                            <p>We hope you have a great experience with us. If you have any questions or need assistance, feel free to contact our support team.</p>
                          </div>
                          <div class="footer">
                            <p>Follow us on social media:</p>
                            <div class="social-icons">
                              <a href="https://www.instagram.com/aquakart.co.in/">
                                <img src="https://static-00.iconduck.com/assets.00/instagram-icon-2048x2048-uc6feurl.png" width="30" height="30" alt="Instagram"/>
                              </a>
                              <a href="https://www.x.com/aquakart8">
                                <img src="https://img.freepik.com/free-vector/twitter-new-2023-x-logo-white-background-vector_1017-45422.jpg?size=338&ext=jpg" width="30" height="30" alt="Twitter"/>
                              </a>
                            </div>
                            <p>Thank you for choosing AquaKart!</p>
                          </div>
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

export default signupOtpTemplate;
