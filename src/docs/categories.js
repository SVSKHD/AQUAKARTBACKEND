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
        code: {
          type: "string",
          description:
            "Create/update/delete errors. validation: INVALID_PHOTO, INVALID_FIELD, IMAGE_TOO_LARGE, VALIDATION_FAILED; cloudinary_upload: IMAGE_TOO_LARGE_FOR_CLOUDINARY (413), IMAGE_REJECTED_BY_CLOUDINARY (400), CLOUDINARY_TIMEOUT / CLOUDINARY_UPLOAD_FAILED (502); database: DATABASE_ERROR (500); request: REQUEST_TOO_LARGE, FILE_TOO_LARGE, INVALID_JSON, INVALID_UPLOAD; server: SERVER_ERROR.",
          example: "CLOUDINARY_TIMEOUT",
        },
        stage: {
          type: "string",
          enum: [
            "request",
            "validation",
            "cloudinary_upload",
            "database",
            "server",
          ],
        },
        photoIndex: {
          type: "integer",
          description:
            "Position of the failing photo in the final list (kept photos first, then new files).",
        },
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
        "Repeat the photos field for multiple files (10 MiB maximum per file, at most 10 files). Swagger 2 UI supports one file here; use repeated multipart fields for multiple files. Preferred over base64 data URIs in JSON: smaller requests and no JSON size limits.",
    },
    ...(create
      ? []
      : [
          {
            name: "keepPhotos",
            in: "formData",
            type: "string",
            description:
              'Update only, with photos files. JSON array of existing photos to keep, in order, e.g. [{"id":"categories/a","secure_url":"https://res.cloudinary.com/..."}]. The uploaded files are added after them. Without keepPhotos the files replace the whole photo list.',
          },
        ]),
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
          maxItems: 10,
          items: {
            description:
              "Existing photo { id, secure_url } (kept as is), an image URL, or a data URI",
          },
          example: [
            {
              id: "subcategories/automatic",
              secure_url:
                "https://res.cloudinary.com/aquakartproducts/image/upload/v1/subcategories/automatic.jpg",
            },
            "data:image/png;base64,iVBORw0KGgo...",
          ],
          description:
            "Optional. A non-empty array replaces the photo list on update; an empty array leaves existing photos unchanged. Existing { id, secure_url } objects and URLs already in Aquakart's Cloudinary account are kept without re-uploading; data URIs and other URLs are uploaded to subcategories/. Invalid entries return 400. Data URIs and multipart files must really be images (checked by content: JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF; SVG is refused) and at most 10 MB each (413 otherwise); nothing is uploaded if any entry is invalid. After saving, replaced photos are deleted from Cloudinary unless another category, subcategory, product or blog uses them.",
        },
        clearPhotos: {
          type: "boolean",
          example: false,
          description:
            "Update only. true removes all photos (send without photos, or with an empty array). Combining it with a non-empty photos array returns 400.",
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
                  "Server error. Create, update and delete return a generic message with code DATABASE_ERROR or SERVER_ERROR; the read endpoints may include the error message (the category title lookup returns 'Server error').",
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
          : "Title is required; No photos provided; or an invalid image",
        409: `A ${key} with this title already exists`,
        413: "Each image must be 10 MB or smaller; or Cloudinary rejected the image as too large",
        502: "Image upload to Cloudinary failed or timed out (code CLOUDINARY_UPLOAD_FAILED or CLOUDINARY_TIMEOUT); nothing was saved",
      },
      description: sub
        ? "Supply title and either category or category_id. Photos are optional. Titles are unique across subcategories (case-insensitive, trimmed); a duplicate returns 409. The returned parent category is an ID. New uploads are removed again if saving fails."
        : "Supply title and at least one photo: multipart photo files, or (as the CRM does) a JSON body whose photos array holds data URIs / image URLs / { id, secure_url } objects. New images are uploaded to categories/. " +
          "Data URIs and multipart files must really be images (checked by content: JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF; SVG is refused) and at most 10 MB each (413 otherwise); nothing is uploaded if any entry is invalid. Titles are unique (case-insensitive, trimmed); a duplicate returns 409. New uploads are removed again if saving fails.",
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
            : "Invalid category ID; Title is required; or an invalid image",
          404: `${label} not found`,
          409: `A ${key} with this title already exists`,
          413: "Each image must be 10 MB or smaller; or Cloudinary rejected the image as too large",
          502: "Image upload to Cloudinary failed or timed out (code CLOUDINARY_UPLOAD_FAILED or CLOUDINARY_TIMEOUT); nothing was saved and existing photos are unchanged",
        },
        description: sub
          ? "Legacy form: supply id or _id in the JSON body. Prefer PUT /v1/subcategory-update/{id}. Omitted fields remain unchanged. The response includes the populated parent category."
          : "Partial update. Omitted fields remain unchanged. Photos: multipart files replace the whole list; or a JSON photos array (the CRM) where existing { id, secure_url } entries are kept and data URIs / new URLs are uploaded. An empty or omitted list keeps the current photos. Data URIs and multipart files must really be images (checked by content: JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF; SVG is refused) and at most 10 MB each (413 otherwise); nothing is uploaded if any entry is invalid. Changing the title to one another category uses returns 409. After saving, photos no longer in the list are deleted from Cloudinary unless another category, subcategory, product or blog uses them; if saving fails, new uploads are removed.",
      },
    );
    if (sub) {
      operation("/v1/subcategory-update/{id}", "put", "Update subcategory", {
        sub,
        admin: true,
        consumes: ["application/json"],
        parameters: [pathParam("id"), subBody(false)],
        schema: success(model),
        errors: {
          400: "Invalid subcategory ID; A valid parent category is required; Parent category not found; Title is required; an invalid image; or Send either photos or clearPhotos, not both",
          404: `${label} not found`,
          409: "A subcategory with this title already exists",
          413: "Each image must be 10 MB or smaller; or Cloudinary rejected the image as too large",
          502: "Image upload to Cloudinary failed or timed out; nothing was saved",
        },
        description:
          "Used by the CRM. The id comes from the path. Supply category or category_id to move it; omitted fields remain unchanged. photos (max 10) replaces the photo list; send [] or omit to keep it. Data URIs are always uploaded to subcategories/ (even with an id); URLs in Aquakart's Cloudinary account are kept with the public id read from the URL; other https entries with an id are kept; other URLs are uploaded. Invalid entries return 400. Data URIs and multipart files must really be images (checked by content: JPEG, PNG, WebP, GIF, AVIF, HEIC, BMP or TIFF; SVG is refused) and at most 10 MB each (413 otherwise); nothing is uploaded if any entry is invalid. clearPhotos: true removes all photos. Replaced photos are deleted from Cloudinary after saving unless another record uses them; if saving fails, new uploads are removed. Changing the title to one another subcategory uses returns 409. The response includes the populated parent category.",
      });
    }
    for (const path of [`/v1/${key}/delete/{id}`, `/v1/${key}-delete/{id}`]) {
      operation(path, "delete", `Delete ${key}`, {
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
        description: path.includes("-delete/")
          ? "Path used by the CRM; same behaviour as /v1/" +
            key +
            "/delete/{id}. Returns the deleted document. Remove references before deleting. After the delete, its photos are removed from Cloudinary unless another record uses them."
          : "Returns the deleted document. Remove references before deleting. After the delete, its photos are removed from Cloudinary unless another record uses them.",
      });
    }
  }
  return doc;
};
