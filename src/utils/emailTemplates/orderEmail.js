import formatCurrencyINR from "../../utils/currency.js";  // Adjust the import path as necessary

const orderEmail = (order, email, totalAmount, estimatedDelivery) => {
  const { items, paymentMethod } = order;

  // Generate the HTML for each item
  const orderItemsHTML = items
    .map(
      (item) => `
      <tr>
        <td>${item.name}</td>
        <td>${item.quantity} x ${formatCurrencyINR(item.price)}</td>
        <td>${formatCurrencyINR(item.quantity * item.price)}</td>
      </tr>
    `
    )
    .join("");



  // Return the final email HTML
  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <title>Your Order Confirmation</title>
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
          table {
            width: 100%;
          }
          th {
            text-align: left;
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
                    <h1>Thank you for your order!</h1>
                    <p>Here are the details of your purchase:</p>
                    <table cellspacing="0" cellpadding="10" border="1">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Quantity x Price</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${orderItemsHTML}
                      </tbody>
                    </table>
                    <p><strong>Total Amount: ${totalAmount}</strong></p>
                    <p><strong>Estimated Delivery: ${estimatedDelivery}</strong></p>
                    <p>Payment Method: <strong>${paymentMethod}</strong></p>
                    <p>Your order will be shipped to the email address registered: <strong>${email}</strong></p>
                    <hr>
                    <p>If you have any questions, please contact our support team or visit <a href="https://aquakart.co.in/">our website</a>.</p>
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

export default orderEmail;
