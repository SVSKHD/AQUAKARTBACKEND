// Explicit contracts override inference where uploads and shared controllers
// prevent swagger-autogen from discovering the actual request/response shapes.
export const applyCategoryDocs = (doc) => {
  const ref = (name) => ({ $ref: `#/definitions/${name}` });
  const string = (description) => ({ type: "string", description });
  const objectId = {
    type: "string",
    pattern: "^[a-fA-F0-9]{24}$",
    example: "507f1f77bcf86cd799439011",
  };
  const photo = {
    type: "object",
    properties: {
      _id: objectId,
      id: string("Cloudinary public ID"),
      secure_url: { type: "string", format: "uri" },
    },
  };
  const category = {
    type: "object",
    properties: {
      _id: objectId,
      title: { type: "string", example: "Water Softeners" },
      description: { type: "string", example: "Water softening solutions" },
      keywords: { type: "string", example: "water, softener" },
      photos: { type: "array", items: photo },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
      __v: { type: "integer" },
    },
  };
  const subcategory = (populated) => ({
    type: "object",
    properties: {
      ...category.properties,
      category: populated
        ? { ...ref("Category"), "x-nullable": true }
        : objectId,
    },
  });
  doc.definitions = {
    ...doc.definitions,
    Category: category,
    CategoryListItem: {
      type: "object",
      properties: {
        ...category.properties,
        photos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ...photo.properties,
              delivery_url: {
                type: "string",
                format: "uri",
                description:
                  "Optimized Cloudinary delivery URL; returned by the category list endpoint only.",
              },
            },
          },
        },
      },
    },
    Subcategory: subcategory(false),
    PopulatedSubcategory: subcategory(true),
    CategoryError: {
      type: "object",
      required: ["success", "message"],
      properties: {
        success: { type: "boolean", example: false },
        message: { type: "string" },
      },
    },
    CategoryAuthError: {
      type: "object",
      required: ["message"],
      properties: { message: { type: "string" } },
    },
  };
  doc.securityDefinitions = {
    ...doc.securityDefinitions,
    CategoryAdminToken: {
      type: "apiKey",
      in: "header",
      name: "Authorization",
      description:
        "Enter Bearer <admin JWT>. Requires role 1 or super-admin; disabled staff are denied.",
    },
  };
  doc.tags = [
    ...(doc.tags || []).filter(
      ({ name }) => !["Categories", "Subcategories"].includes(name),
    ),
    {
      name: "Categories",
      description: "Category browsing and admin management",
    },
    {
      name: "Subcategories",
      description: "Subcategory browsing and admin management",
    },
  ];
  const response = (description, schema, example) => ({
    description,
    schema,
    ...(example ? { examples: { "application/json": example } } : {}),
  });
  const error = (message, auth = false) => {
    const exampleMessage = message.split(";")[0];
    return response(
      message,
      ref(auth ? "CategoryAuthError" : "CategoryError"),
      auth
        ? { message: exampleMessage }
        : { success: false, message: exampleMessage },
    );
  };
  const success = (model, list = false, related = false) => ({
    type: "object",
    required: ["success", "data"],
    properties: {
      success: { type: "boolean", example: true },
      data: list ? { type: "array", items: ref(model) } : ref(model),
      ...(related
        ? {
            relatedProducts: {
              type: "array",
              description:
                "Full, unpopulated product documents matching this category/subcategory.",
              items: { type: "object", additionalProperties: true },
            },
          }
        : {}),
    },
  });
  const pathParam = (name) => ({
    name,
    in: "path",
    required: true,
    ...(name === "id"
      ? objectId
      : {
          type: "string",
          description:
            "Exact title (case-sensitive). URL-encode spaces and special characters.",
          example: "Water Softeners",
        }),
  });
  const fields = (create) => [
    {
      name: "title",
      in: "formData",
      type: "string",
      required: create,
      description: "Non-blank category title",
    },
    {
      name: "description",
      in: "formData",
      type: "string",
      description: "Category description",
    },
    {
      name: "keywords",
      in: "formData",
      type: "string",
      description: "Keywords as a string, not an array",
    },
    {
      name: "photos",
      in: "formData",
      type: "file",
      required: create,
      description:
        "Repeat the photos field for multiple files (10 MiB maximum per file). Swagger 2 UI supports one file here; use repeated multipart fields for multiple files.",
    },
  ];
  const subBody = (create) => ({
    name: "body",
    in: "body",
    required: true,
    schema: {
      type: "object",
      required: create ? ["title"] : [],
      properties: {
        ...(create
          ? {}
          : {
              id: {
                ...objectId,
                description: "Required update target; _id is also accepted.",
              },
              _id: {
                ...objectId,
                description: "Alias for id; id takes precedence.",
              },
            }),
        title: {
          type: "string",
          example: "Domestic Softeners",
          description: "Must be non-blank when supplied",
        },
        description: { type: "string", example: "Softeners for homes" },
        keywords: { type: "string", example: "home, softener" },
        category: {
          ...objectId,
          description:
            "Existing parent category ID. Required on create unless category_id is supplied. Optional on update.",
        },
        category_id: {
          ...objectId,
          description: "Alias for category; category takes precedence.",
        },
        photos: {
          type: "array",
          items: { type: "string" },
          example: ["https://example.com/softener.jpg"],
          description:
            "Cloudinary-compatible image URLs or data URIs. Optional; a non-empty array replaces existing photos on update. An empty array leaves existing photos unchanged.",
        },
      },
    },
  });
  const operation = (
    path,
    method,
    summary,
    {
      sub = false,
      admin = false,
      parameters = [],
      schema,
      status = 200,
      errors = {},
      description = "",
      consumes,
    } = {},
  ) => {
    doc.paths[path] = {
      ...doc.paths[path],
      [method]: {
        tags: [sub ? "Subcategories" : "Categories"],
        summary,
        description,
        produces: ["application/json"],
        ...(consumes ? { consumes } : {}),
        security: admin ? [{ CategoryAdminToken: [] }] : [],
        parameters,
        responses: {
          [status]: response(status === 201 ? "Created" : "OK", schema),
          ...(admin
            ? {
                401: error("No token provided, authorization denied", true),
                403: error("Admin access required", true),
              }
            : {}),
          ...Object.fromEntries(
            Object.entries(errors).map(([code, message]) => [
              code,
              error(message),
            ]),
          ),
          ...(schema && !path.endsWith("-status")
            ? {
                500: response(
                  "Server error; message contains the controller error details (the category title lookup returns 'Server error').",
                  ref("CategoryError"),
                ),
              }
            : {}),
        },
      },
    };
  };
  for (const sub of [false, true]) {
    const label = sub ? "Subcategory" : "Category";
    const key = sub ? "subcategory" : "category";
    const model = sub ? "PopulatedSubcategory" : "Category";
    operation(`/v1/${key}-status`, "get", `${label} service status`, {
      sub,
      schema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            example: sub
              ? "Subcategory status v1 active"
              : "Category Status v1 active",
          },
        },
      },
    });
    operation(
      sub ? "/v1/all-subcategories" : "/v1/allcategories",
      "get",
      `List all ${sub ? "subcategories" : "categories"}`,
      { sub, schema: success(sub ? model : "CategoryListItem", true) },
    );
    operation(`/v1/${key}/{id}`, "get", `Get ${key} by ID`, {
      sub,
      parameters: [pathParam("id")],
      schema: success(model, false, !sub),
      errors: { 400: `Invalid ${key} ID`, 404: `${label} not found` },
    });
    operation(`/v1/${key}-title/{title}`, "get", `Get ${key} by exact title`, {
      sub,
      parameters: [pathParam("title")],
      schema: success(model, false, true),
      errors: { 404: `${label} not found` },
    });
    operation(`/v1/${key}-add`, "post", `Create ${key}`, {
      sub,
      admin: true,
      consumes: [sub ? "application/json" : "multipart/form-data"],
      parameters: sub ? [subBody(true)] : fields(true),
      schema: success(sub ? "Subcategory" : model),
      status: 201,
      errors: {
        400: sub
          ? "A valid parent category is required; Parent category not found; or Title is required"
          : "Title is required; or No photos provided",
      },
      description: sub
        ? "Supply title and either category or category_id. Photos are optional. The returned parent category is an ID."
        : "Supply title and at least one photo file. Do not send photos as JSON or URL strings.",
    });
    operation(
      sub ? "/v1/subcategory-update" : "/v1/category-update/{id}",
      sub ? "post" : "put",
      `Update ${key}`,
      {
        sub,
        admin: true,
        consumes: [sub ? "application/json" : "multipart/form-data"],
        parameters: sub
          ? [subBody(false)]
          : [pathParam("id"), ...fields(false)],
        schema: success(model),
        errors: {
          400: sub
            ? "Invalid subcategory ID; A valid parent category is required; Parent category not found; or Title is required"
            : "Invalid category ID; or Title is required",
          404: `${label} not found`,
        },
        description: sub
          ? "Supply id or _id in the JSON body. Omitted fields remain unchanged. The response includes the populated parent category."
          : "Partial update. Omitted fields remain unchanged. Uploading photos replaces the entire photo list and deletes previous Cloudinary photos; omit photos to keep them.",
      },
    );
    operation(`/v1/${key}/delete/{id}`, "delete", `Delete ${key}`, {
      sub,
      admin: true,
      parameters: [pathParam("id")],
      schema: success(sub ? "Subcategory" : model),
      errors: {
        400: `Invalid ${key} ID`,
        404: `${label} not found`,
        409: sub
          ? "Cannot delete subcategory while products reference it"
          : "Cannot delete category while subcategories or products reference it",
      },
      description:
        "Returns the deleted document. Remove references before deleting.",
    });
  }
  return doc;
};
