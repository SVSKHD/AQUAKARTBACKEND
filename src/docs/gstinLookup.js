// Explicit contract for the CRM GSTIN lookup (GST portal record via Masters
// India). swagger-autogen only infers 200/401/500 for this route.
export const applyGstinLookupDocs = (doc) => {
  const path = "/v1/crm/admin/gstin/{gstin}";
  const error = (code, description) => ({
    description,
    schema: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string" },
        code: { type: "string", example: code },
      },
    },
  });
  const existing = doc.paths[path]?.get || {};
  doc.paths[path] = {
    ...doc.paths[path],
    get: {
      ...existing,
      tags: existing.tags || ["CRM / Invoices"],
      summary: "Look up a GSTIN on the GST portal",
      description:
        "Staff only (admin JWT). Validates the GSTIN (format + check digit), then reads the taxpayer record from the government GST system through Masters India (a licensed GSP). Read-only. Results are cached in memory for 24 h (not-found for 1 h) because provider lookups are billed. Disabled with 503 until MASTERS_INDIA_USERNAME, MASTERS_INDIA_PASSWORD, MASTERS_INDIA_CLIENT_ID and MASTERS_INDIA_CLIENT_SECRET are set.",
      produces: ["application/json"],
      parameters: [
        {
          name: "gstin",
          in: "path",
          required: true,
          type: "string",
          minLength: 15,
          maxLength: 15,
          example: "36HEDPS5768R1Z8",
        },
        { name: "Authorization", in: "header", type: "string", required: true },
      ],
      responses: {
        200: {
          description: "Taxpayer found",
          schema: {
            type: "object",
            properties: {
              success: { type: "boolean", example: true },
              data: {
                type: "object",
                properties: {
                  gstin: { type: "string" },
                  legalName: { type: "string" },
                  tradeName: { type: "string" },
                  status: { type: "string", example: "Active" },
                  constitution: { type: "string", example: "Proprietorship" },
                  taxpayerType: { type: "string", example: "Regular" },
                  registeredOn: { type: "string", example: "27/01/2018" },
                  cancelledOn: { type: "string" },
                  address: {
                    type: "string",
                    description: "Principal place of business, one line",
                  },
                  state: { type: "string" },
                  pincode: { type: "string" },
                  source: { type: "string", example: "mastersindia" },
                  fetchedAt: { type: "string", format: "date-time" },
                  cached: { type: "boolean" },
                },
              },
            },
          },
        },
        400: error("GSTIN_INVALID", "Not a valid GSTIN"),
        401: { description: "Missing or invalid token" },
        403: { description: "Not an admin" },
        404: error("GSTIN_NOT_FOUND", "No taxpayer with this GSTIN"),
        500: error("GSTIN_LOOKUP_FAILED", "Unexpected server error"),
        502: error(
          "GSTIN_PROVIDER_ERROR",
          "Provider error: GSTIN_PROVIDER_AUTH, GSTIN_PROVIDER_ERROR or GSTIN_PROVIDER_UNREACHABLE",
        ),
        503: error("GSTIN_LOOKUP_DISABLED", "Provider credentials not set"),
        504: error("GSTIN_PROVIDER_TIMEOUT", "Provider timed out"),
      },
    },
  };
  return doc;
};
