import AquaInvoice from "../models/crm/invoice.js";

const getStorefrontStats = async (_req, res) => {
  try {
    const invoiceFilter = { quotation: { $ne: true } };

    const [totalInvoices, customerGroups] = await Promise.all([
      AquaInvoice.countDocuments(invoiceFilter),
      AquaInvoice.aggregate([
        { $match: invoiceFilter },
        {
          $project: {
            rawPhone: {
              $convert: {
                input: "$customerDetails.phone",
                to: "string",
                onError: null,
                onNull: null,
              },
            },
            normalizedPhone: "$customerPhoneNormalized",
            rawEmail: {
              $toLower: {
                $trim: {
                  input: { $ifNull: ["$customerDetails.email", ""] },
                },
              },
            },
            normalizedEmail: "$customerEmailNormalized",
          },
        },
        {
          $project: {
            customerKey: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$rawPhone", null] },
                    { $ne: ["$rawPhone", ""] },
                    { $ne: ["$rawPhone", "0"] },
                  ],
                },
                { $concat: ["phone:", "$rawPhone"] },
                {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$normalizedPhone", null] },
                        { $ne: ["$normalizedPhone", ""] },
                      ],
                    },
                    { $concat: ["phone:", "$normalizedPhone"] },
                    {
                      $cond: [
                        { $ne: ["$rawEmail", ""] },
                        { $concat: ["email:", "$rawEmail"] },
                        {
                          $cond: [
                            {
                              $and: [
                                { $ne: ["$normalizedEmail", null] },
                                { $ne: ["$normalizedEmail", ""] },
                              ],
                            },
                            { $concat: ["email:", "$normalizedEmail"] },
                            null,
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        { $match: { customerKey: { $ne: null } } },
        { $group: { _id: "$customerKey" } },
        { $count: "count" },
      ]),
    ]);

    const customersServed = customerGroups?.[0]?.count || 0;

    res.setHeader(
      "Cache-Control",
      "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
    );

    return res.status(200).json({
      success: true,
      data: {
        totalInvoices,
        customersServed,
      },
    });
  } catch (error) {
    console.error("Failed to build public storefront stats:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to load storefront stats",
    });
  }
};

export default { getStorefrontStats };
