import { BlogToolError } from "./errors.js";

// Minimal client for Meta's Instagram Content Publishing API:
//   POST /{ig-user-id}/media           -> container id
//   GET  /{container-id}?fields=status_code,status
//   POST /{ig-user-id}/media_publish   -> media id
//   GET  /{media-id}?fields=id,permalink,timestamp,media_type,caption
//   GET  /{ig-user-id}/media           -> recent media (for reconciliation)
// The access token travels only in the Authorization header. Errors are
// mapped to stable codes; `transient` marks ones safe to retry.

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);

export class GraphError extends BlogToolError {
  constructor(code, message, { transient = false, status, graphCode } = {}) {
    super(code, message, graphCode ? { graphCode } : undefined);
    this.transient = transient;
    this.retryable = transient;
    this.httpStatus = status;
  }
}

export const createInstagramGraph = (
  config,
  { fetchImpl = globalThis.fetch } = {},
) => {
  const base = `${config.graphBaseUrl}/${config.apiVersion}`;

  const call = async (method, path, params = {}) => {
    if (!config.configured) {
      throw new GraphError(
        "INSTAGRAM_NOT_CONFIGURED",
        "Instagram publishing is not configured on the server",
      );
    }
    const url = new URL(`${base}/${path}`);
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (method === "GET") url.searchParams.set(key, String(value));
      else body.set(key, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${config.accessToken}`,
          ...(method === "GET"
            ? {}
            : { "content-type": "application/x-www-form-urlencoded" }),
        },
        body: method === "GET" ? undefined : body,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      const timeout =
        error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new GraphError(
        timeout ? "META_TIMEOUT" : "META_UNREACHABLE",
        timeout ? "Meta did not answer in time" : "Could not reach Meta",
        { transient: true },
      );
    }
    let data = null;
    try {
      data = await response.json();
    } catch (_error) {
      data = null;
    }
    if (response.ok && data && !data.error) return data;

    const graph = data?.error || {};
    const graphCode = Number(graph.code) || undefined;
    if (graphCode === 190 || response.status === 401) {
      throw new GraphError(
        "INSTAGRAM_TOKEN_INVALID",
        "The Instagram access token is invalid or expired",
        {
          status: response.status,
          graphCode,
        },
      );
    }
    if (RATE_LIMIT_CODES.has(graphCode) || response.status === 429) {
      throw new GraphError(
        "META_RATE_LIMITED",
        "Meta rate limit reached; retry later",
        {
          transient: true,
          status: response.status,
          graphCode,
        },
      );
    }
    if (graphCode === 100 && graph.error_subcode === 33) {
      throw new GraphError("META_NOT_FOUND", "Object not found on Instagram", {
        status: response.status,
        graphCode,
      });
    }
    const transient =
      response.status >= 500 ||
      graph.is_transient === true ||
      graphCode === 2 ||
      graphCode === 1;
    throw new GraphError(
      transient ? "META_UNAVAILABLE" : "META_REQUEST_REJECTED",
      // Meta's own message: never contains the token.
      String(graph.message || `Meta answered ${response.status}`).slice(0, 300),
      { transient, status: response.status, graphCode },
    );
  };

  return {
    createContainer: ({ imageUrl, caption, altText }) =>
      call("POST", `${config.userId}/media`, {
        image_url: imageUrl,
        caption,
        alt_text: altText,
      }).then((d) => d.id),
    getContainer: (containerId) =>
      call("GET", containerId, { fields: "status_code,status" }),
    publishContainer: (containerId) =>
      call("POST", `${config.userId}/media_publish`, {
        creation_id: containerId,
      }).then((d) => d.id),
    getMedia: (mediaId) =>
      call("GET", mediaId, {
        fields: "id,permalink,timestamp,media_type,caption",
      }),
    recentMedia: (limit = 10) =>
      call("GET", `${config.userId}/media`, {
        fields: "id,permalink,timestamp,caption",
        limit,
      }).then((d) => d.data || []),
  };
};
