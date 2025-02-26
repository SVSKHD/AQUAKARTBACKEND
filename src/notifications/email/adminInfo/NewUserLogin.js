const userLoginNotificationTemplateToAdmin = (email, username, loginTime) => {
    return `
            <!DOCTYPE html>
            <html lang="en">
              <head>
                <title>New User Login Notification</title>
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
                  .login-info {
                    font-size: 18px;
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
                            <h1>New User Login Alert</h1>
                            <p>A new user has logged into AquaKart.</p>
                            <div class="login-info">
                              <p><strong>Username:</strong> ${username}</p>
                              <p><strong>Email:</strong> ${email}</p>
                              <p><strong>Login Time:</strong> ${loginTime}</p>
                            </div>
                            <p>If this login seems suspicious, please review the account activity.</p>
                            <div class="footer">
                              <p>Thank you for keeping AquaKart secure.</p>
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
  
  export default userLoginNotificationTemplateToAdmin;
  