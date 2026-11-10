// Final error handler: errors raised before a controller runs (body parser,
// multer) otherwise reach Express's default handler, which answers with HTML.
// Clients (CRM, storefront) expect { success, message } JSON.

const MULTER_413 = new Set(["LIMIT_FILE_SIZE", "LIMIT_FIELD_VALUE"]);

export const jsonErrorStatus = (error) => {
  if (error?.type === "entity.too.large" || MULTER_413.has(error?.code))
    return 413;
  if (error?.type === "entity.parse.failed") return 400;
  if (error?.name === "MulterError") return 400;
  const status = Number(error?.status ?? error?.statusCode);
  return status >= 400 && status < 500 ? status : 500;
};

const MESSAGES = {
  413: "Request too large. Each image must be 10 MB or smaller.",
  400: "Invalid request body",
};

// eslint-disable-next-line no-unused-vars
export const jsonErrorHandler = (error, req, res, next) => {
  const status = jsonErrorStatus(error);
  if (status >= 500) console.error("Unhandled request error:", error);
  if (res.headersSent) return next(error);
  // Only client errors from the body parser / multer carry safe messages.
  const message =
    status === 413
      ? MESSAGES[413]
      : status === 400 && error?.type === "entity.parse.failed"
        ? MESSAGES[400]
        : status < 500 && (error?.expose || error?.name === "MulterError")
          ? error.message
          : status < 500
            ? "Bad request"
            : "Something went wrong, please try again";
  const code =
    error?.type === "entity.too.large"
      ? "REQUEST_TOO_LARGE"
      : MULTER_413.has(error?.code)
        ? "FILE_TOO_LARGE"
        : error?.type === "entity.parse.failed"
          ? "INVALID_JSON"
          : error?.name === "MulterError"
            ? "INVALID_UPLOAD"
            : status < 500
              ? "BAD_REQUEST"
              : "SERVER_ERROR";
  return res
    .status(status)
    .json({ success: false, message, code, stage: "request" });
};
