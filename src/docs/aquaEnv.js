// Explicit contracts for runtime configuration stored in "aqua-env"
// (src/routes/crm/aquaEnv.js). swagger-autogen infers only bare 200s here.
const TAG = "CRM / Environment";

const variable = {
  type: "object",
  properties: {
    key: { type: "string", example: "SMTP_HOST" },
    secret: { type: "boolean" },
    value: {
      type: "string",
      description:
        "Plain value when secret is false. Secrets are masked: '••••' plus the last 4 characters for values of 12+ characters, otherwise '••••'. null when the value cannot be decrypted (readable false).",
      example: "••••a1Z2",
    },
    readable: {
      type: "boolean",
      description: "false when AQUA_ENV_ENCRYPTION_KEY is missing or wrong",
    },
    inEffect: {
      type: "boolean",
      description: "process.env on this instance currently holds this value",
    },
    description: { type: "string" },
    updatedBy: { type: "string", description: "Staff id" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const error = (description, codes) => ({
  description,
  schema: {
    type: "object",
    properties: {
      success: { type: "boolean", example: false },
      code: { type: "string", example: codes[0] },
      message: { type: "string" },
    },
  },
});

const auth = {
  name: "Authorization",
  in: "header",
  type: "string",
  required: true,
};
const keyParam = {
  name: "key",
  in: "path",
  required: true,
  type: "string",
  pattern: "^[A-Z][A-Z0-9_]{0,99}$",
  example: "SMTP_HOST",
};
const common = {
  401: error("Missing or invalid staff token", ["AUTH"]),
  403: error("Missing permission", ["FORBIDDEN"]),
  500: error("Server error", ["SERVER_ERROR"]),
};
const ok = (data, extra = {}) => ({
  type: "object",
  properties: { success: { type: "boolean", example: true }, data, ...extra },
});
const restartNote = {
  restartNote: {
    type: "string",
    description:
      "Changes apply to process.env on the instance that handled the request; settings read only at startup need a restart.",
  },
};

export const applyAquaEnvDocs = (doc) => {
  doc.paths["/v1/crm/env/"] = {
    get: {
      tags: [TAG],
      summary: "List stored configuration variables",
      description:
        "Permission settings.read. Lists the variables in the aqua-env collection with secrets masked. Values are never returned in full for secrets. status.lastLoad reports which keys were applied at startup (names only).",
      parameters: [auth],
      responses: {
        200: {
          description: "Variables",
          schema: ok(
            { type: "array", items: variable },
            {
              status: {
                type: "object",
                properties: {
                  keyConfigured: { type: "boolean" },
                  lastLoad: {
                    type: "object",
                    properties: {
                      at: { type: "string", format: "date-time" },
                      total: { type: "integer" },
                      loaded: { type: "array", items: { type: "string" } },
                      failed: { type: "array", items: { type: "string" } },
                      skipped: { type: "array", items: { type: "string" } },
                      keyConfigured: { type: "boolean" },
                      error: { type: "string" },
                    },
                  },
                },
              },
            },
          ),
        },
        ...common,
      },
    },
  };
  doc.paths["/v1/crm/env/{key}"] = {
    get: {
      tags: [TAG],
      summary: "Get one stored variable (masked if secret)",
      description: "Permission settings.read.",
      parameters: [keyParam, auth],
      responses: {
        200: { description: "Variable", schema: ok(variable) },
        404: error("Not stored", ["NOT_FOUND"]),
        ...common,
      },
    },
    put: {
      tags: [TAG],
      summary: "Create or update a variable",
      description:
        "Permission settings.manage. value is required when creating; on update, omitted fields keep their stored values. The value is encrypted (AES-256-GCM) before it is stored and is applied to process.env on this instance immediately. DB_URL, AQUA_ENV_ENCRYPTION_KEY, PORT, PATH-like OS variables and NODE_/NPM_/PM2_/DOPPLER_/LD_/DYLD_ prefixes are refused. Audited as settings.env.create/update with no values.",
      parameters: [
        keyParam,
        auth,
        {
          name: "body",
          in: "body",
          required: true,
          schema: {
            type: "object",
            properties: {
              value: { type: "string", maxLength: 20000 },
              secret: {
                type: "boolean",
                description: "Mask in responses (default true on create)",
              },
              description: { type: "string", maxLength: 300 },
            },
          },
        },
      ],
      responses: {
        200: { description: "Updated", schema: ok(variable, restartNote) },
        201: { description: "Created", schema: ok(variable, restartNote) },
        400: error("Invalid name, reserved name, or invalid field", [
          "INVALID_KEY",
          "RESERVED_KEY",
          "INVALID_VALUE",
          "INVALID_SECRET",
          "INVALID_DESCRIPTION",
        ]),
        409: error("Concurrent create", ["CONFLICT"]),
        503: error("AQUA_ENV_ENCRYPTION_KEY is not set on the server", [
          "ENCRYPTION_KEY_MISSING",
        ]),
        ...common,
      },
    },
    delete: {
      tags: [TAG],
      summary: "Delete a stored variable",
      description:
        "Permission settings.manage. process.env falls back to the server environment value (.env/Doppler) if there was one, otherwise the variable is removed. Audited as settings.env.delete.",
      parameters: [keyParam, auth],
      responses: {
        200: {
          description: "Deleted",
          schema: ok(
            {
              type: "object",
              properties: {
                key: { type: "string" },
                secret: { type: "boolean" },
                fallback: { type: "string", enum: ["server-env", "none"] },
              },
            },
            restartNote,
          ),
        },
        404: error("Not stored", ["NOT_FOUND"]),
        ...common,
      },
    },
  };
  return doc;
};
