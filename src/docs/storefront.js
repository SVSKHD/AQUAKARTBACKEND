// Explicit contract for the public recent-purchases feed (query params are
// parsed in a service, so swagger-autogen cannot infer them).
export const applyStorefrontDocs = (doc) => {
  const hour = {
    type: "string",
    format: "date-time",
    "x-nullable": true,
    description: "Rounded down to the hour",
  };
  const product = {
    productName: { type: "string", example: "Kent Automatic Softener 8L" },
    productSlug: { type: "string", "x-nullable": true },
    productId: { type: "string", "x-nullable": true },
  };
  const path = "/v1/storefront/recent-purchases";
  doc.paths[path] = {
    ...doc.paths[path],
    get: {
      ...doc.paths[path]?.get,
      tags: doc.paths[path]?.get?.tags || ["Storefront"],
      summary: "Recent purchases and most-bought products",
      description:
        "Public, anonymous demand feed from invoices (quotations excluded) for social proof on the store. Returns product details, a locality picked from the address and an hour-rounded time only; never names, phones, emails, invoice numbers or full addresses. Cached for 60s (CDN 300s).",
      produces: ["application/json"],
      parameters: [
        {
          name: "area",
          in: "query",
          type: "string",
          maxLength: 60,
          description:
            "Optional locality, matched case-insensitively as literal text in the invoice address (e.g. Kondapur)",
        },
        {
          name: "limit",
          in: "query",
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 10,
          description:
            "Recent purchase lines to return; out-of-range values are clamped",
        },
        {
          name: "days",
          in: "query",
          type: "integer",
          minimum: 1,
          maximum: 90,
          default: 30,
          description:
            "Look-back window in days; out-of-range values are clamped",
        },
      ],
      responses: {
        200: {
          description: "OK",
          schema: {
            type: "object",
            properties: {
              success: { type: "boolean", example: true },
              data: {
                type: "object",
                properties: {
                  area: { type: "string", "x-nullable": true },
                  days: { type: "integer", example: 30 },
                  recent: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        ...product,
                        quantity: { type: "integer", example: 1 },
                        area: {
                          type: "string",
                          "x-nullable": true,
                          example: "Gachibowli",
                        },
                        purchasedAt: hour,
                      },
                    },
                  },
                  trending: {
                    type: "array",
                    description:
                      "Top 5 products by invoice count in the window",
                    items: {
                      type: "object",
                      properties: {
                        ...product,
                        orders: { type: "integer" },
                        units: { type: "integer" },
                        lastPurchasedAt: hour,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        500: {
          description: "Database failure",
          schema: {
            type: "object",
            properties: {
              success: { type: "boolean", example: false },
              message: { type: "string" },
            },
          },
        },
      },
    },
  };
  return doc;
};
