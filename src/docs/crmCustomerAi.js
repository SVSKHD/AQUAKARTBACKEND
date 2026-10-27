export const applyCrmCustomerAiDocs = (doc) => {
  const id = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
  const date = { type: "string", format: "date-time" };
  const ref = (name) => ({ $ref: `#/definitions/${name}` });
  const fields = {
    _id: id,
    firstName: { type: "string" },
    lastName: { type: "string" },
    email: { type: "string" },
    phone: { type: "number" },
    photoURL: { type: "string" },
    createdAt: date,
    lastLoginAt: date,
    loginCount: { type: "number" },
    emailVerified: { type: "boolean" },
    ai: {
      type: "object",
      properties: {
        chats: { type: "integer" },
        messages: { type: "integer" },
        lastMessageAt: { ...date, "x-nullable": true },
      },
    },
  };
  const msg = {
    type: "object",
    properties: {
      _id: id,
      role: { type: "string", enum: ["user", "model"] },
      text: { type: "string" },
      createdAt: date,
    },
  };
  const summary = {
    _id: id,
    user: id,
    title: { type: "string" },
    pinned: { type: "boolean" },
    messageCount: { type: "integer" },
    lastMessageAt: date,
    createdAt: date,
    updatedAt: date,
  };
  doc.definitions = {
    ...doc.definitions,
    CrmAiCustomer: { type: "object", properties: fields },
    CrmCustomerChatSummary: { type: "object", properties: summary },
    CrmCustomerChat: {
      type: "object",
      properties: {
        ...summary,
        messages: { type: "array", items: msg },
        qa: {
          type: "array",
          items: {
            type: "object",
            properties: {
              questionId: id,
              answerId: id,
              question: { type: "string" },
              answer: { type: "string" },
              askedAt: date,
              answeredAt: date,
            },
          },
        },
      },
    },
    CrmCustomerBlog: {
      type: "object",
      properties: {
        _id: id,
        title: { type: "string" },
        slug: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["draft", "published"] },
        generatedBy: { type: "string" },
        createdAt: date,
      },
      additionalProperties: true,
    },
    CrmCustomerAiError: {
      type: "object",
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string" },
        required: { type: "array", items: { type: "string" } },
      },
    },
  };
  doc.securityDefinitions = {
    ...doc.securityDefinitions,
    CrmCustomerAiStaff: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description:
        "Bearer <staff JWT>. Review requires customers.read + ai.chats.read. Blog draft actions additionally require blogs.manage. Super-admin/legacy role 1 has access.",
    },
  };
  const params = [
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
  ];
  const userId = { name: "userId", in: "path", required: true, ...id };
  const chatId = { name: "chatId", in: "path", required: true, ...id };
  const page = {
    type: "object",
    properties: Object.fromEntries(
      ["page", "limit", "total", "pages"].map((key) => [
        key,
        { type: "integer" },
      ]),
    ),
  };
  const add = (
    path,
    method,
    title,
    parameters,
    schema,
    paginated = false,
    description = "",
  ) => {
    const response = {
      type: "object",
      properties: {
        success: { type: "boolean", example: true },
        data: schema,
        ...(paginated ? { pagination: page } : {}),
      },
    };
    doc.paths[path] = {
      ...doc.paths[path],
      [method]: {
        tags: ["CRM / AI"],
        summary: title,
        description,
        security: [{ CrmCustomerAiStaff: [] }],
        produces: ["application/json"],
        ...(method === "post" ? { consumes: ["application/json"] } : {}),
        parameters,
        responses: {
          [method === "post" ? 201 : 200]: {
            description:
              method === "post" ? "Draft created; never auto-published" : "OK",
            schema: response,
          },
          ...Object.fromEntries(
            [
              [
                400,
                "Invalid IDs, pagination, instructions or question selection",
              ],
              [401, "Staff authentication required"],
              [403, "Insufficient permission"],
              [404, "User or user-owned chat not found"],
              [500, "Database failure"],
            ].map(([code, text]) => [
              code,
              { description: text, schema: ref("CrmCustomerAiError") },
            ]),
          ),
        },
      },
    };
    return doc.paths[path][method];
  };
  const root = "/v1/crm/ai/users";
  add(
    root,
    "get",
    "Search customer users with AI chat statistics",
    [
      ...params,
      {
        name: "q",
        in: "query",
        type: "string",
        maxLength: 120,
        description: "Literal name/email search or exact phone number",
      },
    ],
    { type: "array", items: ref("CrmAiCustomer") },
    true,
    "Safe profile allowlist only; passwords, OTPs and provider payloads are never selected. All users are eligible, including users with zero saved chats.",
  );
  add(
    `${root}/{userId}`,
    "get",
    "Read a customer profile and chat totals",
    [userId],
    ref("CrmAiCustomer"),
  );
  add(
    `${root}/{userId}/chats`,
    "get",
    "List this customer's saved storefront chats",
    [userId, ...params],
    { type: "array", items: ref("CrmCustomerChatSummary") },
    true,
    "Newest activity first. Does not include staff-owned CRM chats or unsaved guest chats.",
  );
  add(
    `${root}/{userId}/chats/{chatId}`,
    "get",
    "Read a customer's questions and AI answers",
    [userId, chatId],
    ref("CrmCustomerChat"),
    false,
    "Returns retained messages and answered qa pairs with questionId/answerId. Only a chat whose user matches userId can be loaded.",
  );
  add(
    `${root}/{userId}/chats/{chatId}/blog-drafts`,
    "get",
    "List blogs generated from this customer chat",
    [userId, chatId, ...params],
    { type: "array", items: ref("CrmCustomerBlog") },
    true,
    "Requires blogs.manage in addition to customer/chat read permissions. Returns metadata without article body, including status of subsequently published drafts.",
  );
  const create = add(
    `${root}/{userId}/chats/{chatId}/blog-drafts`,
    "post",
    "Generate a draft blog from selected customer Q/A",
    [
      userId,
      chatId,
      {
        name: "body",
        in: "body",
        required: true,
        schema: {
          type: "object",
          properties: {
            questionIds: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: id,
              description:
                "User-role message IDs from this chat's qa list. Omit to use its latest 20 complete exchanges.",
            },
            instructions: {
              type: "string",
              maxLength: 2000,
              example: "Write a practical hard-water troubleshooting guide",
            },
          },
        },
      },
    ],
    {
      type: "object",
      properties: {
        blog: ref("CrmCustomerBlog"),
        model: { type: "string" },
        source: {
          type: "object",
          properties: { chatId: id, questionIds: { type: "array", items: id } },
        },
      },
    },
    false,
    "Requires blogs.manage. Uses stored exchanges, redacts known names and common contact/reference patterns before AI generation, then saves an unpublished draft with hidden source metadata and an audit entry. Review facts and remaining personal details before publishing with existing blog editor. Each POST creates a separate draft; serialize clicks. Guests/trimmed messages cannot be recovered.",
  );
  for (const [code, description] of [
    [429, "AI provider rate limit"],
    [502, "Invalid/insufficient AI output or provider failure"],
    [503, "AI not configured or unavailable"],
  ])
    create.responses[code] = { description, schema: ref("CrmCustomerAiError") };
  const blogRead = doc.paths["/v1/blog/{id}"]?.get;
  if (blogRead) {
    blogRead.description =
      "Public lookup excludes drafts. To load a draft, CRM administrators supply ?status=draft or ?status=all with an admin Bearer token.";
    blogRead.parameters = (blogRead.parameters || []).filter(
      (parameter) => parameter.name !== "status",
    );
    blogRead.parameters.push({
      name: "status",
      in: "query",
      type: "string",
      enum: ["published", "draft", "all"],
      description: "draft/all requires administrator authentication",
    });
    blogRead.responses[404] = {
      description: "Blog not found or not published",
    };
  }
  return doc;
};
