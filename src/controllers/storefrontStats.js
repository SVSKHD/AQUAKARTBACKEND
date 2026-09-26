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
            customerKey: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$customerPhoneNormalized", null] },
                    { $ne: ["$customerPhoneNormalized", ""] },
                  ],
                },
                { $concat: ["phone:", "$customerPhoneNormalized"] },
                {
                  $cond: [
                    {
                      $and: [
                        { $ne: ["$customerEmailNormalized", null] },
                        { $ne: ["$customerEmailNormalized", ""] },
                      ],
                    },
                    { $concat: ["email:", "$customerEmailNormalized"] },
                    null,
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
