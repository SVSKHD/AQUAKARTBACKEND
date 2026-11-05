import { createHash, randomUUID } from "node:crypto";
import { BlogToolError, RETRYABLE_CODES, toBlogToolError } from "./errors.js";

// Idempotency for MCP write tools. Each call names an idempotencyKey; the
// first call with a key (per OAuth client) runs, later calls with the same
// key and the same arguments get the stored result back instead of running
// again. The same key with different arguments is refused. Failures marked
// retryable (storage/network) may be re-run with the same key; validation
// failures replay their stored error.

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const hashArgs = (tool, args) => {
  const { idempotencyKey: _ignored, ...rest } = args || {};
  return createHash("sha256")
    .update(`${tool}\n${stable(rest)}`)
    .digest("hex");
};

const storedError = (operation) =>
  Object.assign(
    new BlogToolError(
      operation.result?.error?.code || operation.errorCode || "INTERNAL_ERROR",
      operation.result?.error?.message || "Operation failed",
      operation.result?.error?.details,
    ),
    { operationId: operation.operationId, replayed: true },
  );

export const createOperationRunner = ({
  store,
  now = () => new Date(),
  lockMs = 120000,
}) => {
  const claim = async (context) => {
    const lockedUntil = new Date(now().getTime() + lockMs);
    try {
      const operation = await store.createOperation({
        operationId: `op_${randomUUID()}`,
        clientId: context.clientId,
        adminUser: context.adminUserId,
        tool: context.tool,
        idempotencyKey: context.idempotencyKey,
        argsHash: context.argsHash,
        correlationId: context.correlationId,
        status: "processing",
        lockedUntil,
      });
      return { operation };
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }

    const existing = await store.findOperation(
      context.clientId,
      context.idempotencyKey,
    );
    if (!existing) {
      throw new BlogToolError(
        "STORAGE_UNAVAILABLE",
        "Could not read the idempotency record; retry",
      );
    }
    if (
      existing.tool !== context.tool ||
      existing.argsHash !== context.argsHash
    ) {
      throw Object.assign(
        new BlogToolError(
          "IDEMPOTENCY_KEY_REUSED",
          "This idempotencyKey was already used for a different call; use a new key",
        ),
        { operationId: existing.operationId },
      );
    }
    if (existing.status === "succeeded") return { replay: existing };
    if (existing.status === "failed" && !existing.retryable)
      return { replay: existing };
    if (existing.status === "processing" && existing.lockedUntil > now()) {
      throw Object.assign(
        new BlogToolError(
          "OPERATION_IN_PROGRESS",
          "A call with this idempotencyKey is still running; check again shortly",
        ),
        { operationId: existing.operationId },
      );
    }
    // Retryable failure, or a processing record left by a crash: take it over.
    const reclaimed = await store.reclaimOperation(existing, {
      lockedUntil,
      correlationId: context.correlationId,
    });
    if (!reclaimed) {
      throw Object.assign(
        new BlogToolError(
          "OPERATION_IN_PROGRESS",
          "Another retry took this operation; check again shortly",
        ),
        { operationId: existing.operationId },
      );
    }
    return { operation: reclaimed };
  };

  // Runs `execute(operation)` at most once per (client, key). Resolves
  // { result, operationId, replayed } or throws a BlogToolError carrying
  // operationId.
  return async (context, execute) => {
    const full = { ...context, argsHash: hashArgs(context.tool, context.args) };
    const { operation, replay } = await claim(full);
    if (replay) {
      if (replay.status === "succeeded") {
        return {
          result: replay.result,
          operationId: replay.operationId,
          replayed: true,
        };
      }
      throw storedError(replay);
    }

    try {
      const { result, blogId } = await execute(operation);
      await store.finishOperation(operation.operationId, {
        status: "succeeded",
        retryable: false,
        result,
        blogId,
        errorCode: null,
        lockedUntil: null,
        finishedAt: now(),
      });
      return { result, operationId: operation.operationId, replayed: false };
    } catch (caught) {
      const error = toBlogToolError(caught);
      const retryable =
        Boolean(caught?.retryable) || RETRYABLE_CODES.has(error.code);
      await store
        .finishOperation(operation.operationId, {
          status: "failed",
          retryable,
          result: {
            error: {
              code: error.code,
              message: error.message,
              details: error.details,
            },
          },
          errorCode: error.code,
          lockedUntil: null,
          finishedAt: now(),
        })
        .catch((finishError) => {
          console.error(
            "MCP operation bookkeeping failed:",
            finishError.message,
          );
        });
      if (caught !== error && error.code === "INTERNAL_ERROR") {
        console.error(
          `MCP tool ${context.tool} failed:`,
          caught?.message || caught,
        );
      }
      error.operationId = operation.operationId;
      error.retryable = retryable;
      throw error;
    }
  };
};
