export const applyCrmAiDocs = (doc) => {
  const ref = (name) => ({ $ref: `#/definitions/${name}` });
  const id = {
    type: "string",
    pattern: "^[a-fA-F0-9]{24}$",
    example: "6710a1b2c3d4e5f6a7b8c9d0",
  };
  const date = { type: "string", format: "date-time" };
  const message = {
    type: "object",
    properties: {
      _id: id,
      role: { type: "string", enum: ["user", "model"] },
      text: { type: "string" },
      createdAt: date,
    },
  };
  const fields = {
    _id: id,
    staff: id,
    title: { type: "string", maxLength: 120 },
    pinned: { type: "boolean" },
    pinnedAt: { ...date, "x-nullable": true },
    archived: { type: "boolean" },
    messageCount: {
      type: "integer",
      description:
        "Total stored/imported message count including messages trimmed from retention.",
    },
    lastMessageAt: date,
    createdAt: date,
    updatedAt: date,
  };
  doc.definitions = {
    ...doc.definitions,
    CrmChatSummary: { type: "object", properties: fields },
    CrmChat: {
      type: "object",
      properties: {
        ...fields,
        messages: { type: "array", maxItems: 200, items: message },
      },
    },
    CrmChatError: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string" },
      },
    },
    CrmGenerateResult: {
      type: "object",
      properties: {
        sessionId: id,
        reply: { type: "string" },
        model: { type: "string" },
        finishReason: { type: "string" },
        usage: { type: "object", additionalProperties: true },
        thoughts: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
    },
  };
  doc.securityDefinitions = {
    ...doc.securityDefinitions,
    CrmStaffToken: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description:
        "Bearer <staff JWT>. Chats are private to that staff account.",
    },
  };
  const security = [{ CrmStaffToken: [] }];
  const envelope = (data) => ({
    type: "object",
    properties: { success: { type: "boolean", example: true }, data },
  });
  const errors = Object.fromEntries(
    [
      [400, "Invalid input"],
      [401, "Staff authentication required"],
      [404, "Chat not found or owned by another staff account"],
      [500, "Persistence or generation failed"],
    ].map(([code, description]) => [
      code,
      { description, schema: ref("CrmChatError") },
    ]),
  );
  const pathId = {
    name: "id",
    in: "path",
    required: true,
    type: "string",
    pattern: id.pattern,
    "x-example": id.example,
  };
  const body = (schema) => ({
    name: "body",
    in: "body",
    required: true,
    schema,
  });
  const add = (
    path,
    method,
    summary,
    parameters,
    data,
    status = 200,
    description = "",
  ) => {
    doc.paths[path] = {
      ...doc.paths[path],
      [method]: {
        tags: ["CRM / AI"],
        summary,
        description,
        security,
        produces: ["application/json"],
        ...(method === "post" || method === "patch"
          ? { consumes: ["application/json"] }
          : {}),
        parameters,
        responses: {
          ...errors,
          [status]: {
            description: status === 201 ? "Created" : "OK",
            schema: envelope(data),
          },
        },
      },
    };
    return doc.paths[path][method];
  };
  const list = add(
    "/v1/crm/ai/chats",
    "get",
    "List and search your CRM chats",
    [
      {
        name: "page",
        in: "query",
        type: "integer",
        minimum: 1,
        maximum: 1000000,
        default: 1,
      },
      {
        name: "limit",
        in: "query",
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 20,
      },
      {
        name: "q",
        in: "query",
        type: "string",
        maxLength: 120,
        description: "Literal, case-insensitive title search",
      },
      {
        name: "pinned",
        in: "query",
        type: "boolean",
        description: "Omit to include pinned and unpinned chats",
      },
      {
        name: "archived",
        in: "query",
        type: "boolean",
        default: false,
        description: "true returns archived chats only",
      },
    ],
    { type: "array", items: ref("CrmChatSummary") },
    200,
    "Pinned first, then lastMessageAt descending, then _id descending. List responses omit messages.",
  );
  list.responses[200].schema.properties.pagination = {
    type: "object",
    properties: Object.fromEntries(
      ["page", "limit", "total", "pages"].map((key) => [
        key,
        { type: "integer" },
      ]),
    ),
  };
  add(
    "/v1/crm/ai/chats",
    "post",
    "Create an empty CRM conversation",
    [
      body({
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: 120,
            example: "Customer follow-ups",
          },
        },
      }),
    ],
    ref("CrmChat"),
    201,
  );
  add(
    "/v1/crm/ai/chats/{id}",
    "get",
    "Read your chat and its message history",
    [pathId],
    ref("CrmChat"),
    200,
    "Retains the latest 200 messages. No TTL. Includes archived chats; never reads customer or invoice-draft sessions.",
  );
  add(
    "/v1/crm/ai/chats/{id}",
    "patch",
    "Rename, pin/unpin, archive/restore your chat",
    [
      pathId,
      body({
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          pinned: { type: "boolean" },
          archived: { type: "boolean" },
        },
        minProperties: 1,
      }),
    ],
    ref("CrmChatSummary"),
    200,
    "At least one recognized field is required. Omitted fields are unchanged. Pinning stamps pinnedAt; unpinning clears it. Returns metadata without messages.",
  );
  add(
    "/v1/crm/ai/chats/{id}",
    "delete",
    "Permanently delete your chat",
    [pathId],
    {
      type: "object",
      properties: { deleted: { type: "boolean", example: true } },
    },
  );
  const generationBody = body({
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: 20000,
        example: "Draft a customer follow-up",
      },
      sessionId: {
        ...id,
        description:
          "Continue your chat. Server history replaces client history. Omit to create a chat after the first successful reply.",
      },
      history: {
        type: "array",
        items: message,
        description:
          "Optional import/context for a new conversation only. Last 30 entries, each capped to 20,000 characters.",
      },
      systemInstruction: { type: "string", maxLength: 20000 },
      temperature: { type: "number", minimum: 0, maximum: 2, default: 0.7 },
      json: { type: "boolean" },
      thinking: {
        description: "false/off, true (medium), or string medium/high",
        example: "medium",
      },
    },
  });
  for (const suffix of ["", "/stream"]) {
    const operation = add(
      `/v1/crm/ai/generate${suffix}`,
      "post",
      suffix
        ? "Stream a reply and save its completed turn"
        : "Generate a reply and save its completed turn",
      [generationBody],
      ref("CrmGenerateResult"),
      200,
      "Staff-only, no daily customer quota. Uses the last 30 stored messages for context. A successful save returns sessionId. Archived chats must be restored. A concurrent completed turn or deletion returns 409; reload before retrying. Custom generation settings must be supplied on each request.",
    );
    operation.responses[409] = {
      description: "Chat is archived or changed during generation",
      schema: ref("CrmChatError"),
    };
    operation.responses[503] = {
      description: "AI not configured or unavailable",
      schema: ref("CrmChatError"),
    };
    operation.responses[502] = {
      description: "AI provider failure",
      schema: ref("CrmChatError"),
    };
    operation.responses[429] = {
      description: "AI provider rate limit (not a CRM daily quota)",
      schema: ref("CrmChatError"),
    };
    if (suffix) {
      operation.produces = ["text/event-stream", "application/json"];
      operation.responses[200] = {
        description:
          "SSE: thought {index,title,text}; delta {text}; done {reply,thoughts,model,finishReason,usage,sessionId}. done is sent only after persistence succeeds. Before streaming starts errors use JSON/HTTP status; afterwards error {status,message} uses SSE on HTTP 200. Partial/error replies are not saved.",
        schema: { type: "string" },
      };
    }
  }
  return doc;
};
