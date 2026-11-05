// Structured errors for the Aquakart MCP tools. Every failure a tool reports
// carries a stable `code` so ChatGPT (or any MCP client) can branch on it:
//   { ok: false, error: { code, message, details? }, correlationId }

export class BlogToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// Maps anything thrown inside a tool to a BlogToolError. Unknown errors
// become INTERNAL_ERROR so stack traces and internals never leak.
export const toBlogToolError = (error) => {
  if (error instanceof BlogToolError) return error;
  if (error?.name === "ValidationError" && error.errors) {
    return new BlogToolError(
      "VALIDATION_FAILED",
      "Blog failed model validation",
      Object.values(error.errors).map((item) => ({
        field: item.path,
        message: item.message,
      })),
    );
  }
  if (error?.name === "CastError") {
    return new BlogToolError("VALIDATION_FAILED", `Invalid ${error.path}`);
  }
  return new BlogToolError("INTERNAL_ERROR", "Unexpected server error");
};

// Errors worth retrying with the same idempotency key.
export const RETRYABLE_CODES = new Set([
  "INTERNAL_ERROR",
  "STORAGE_UNAVAILABLE",
  "IMAGE_DOWNLOAD_FAILED",
]);
