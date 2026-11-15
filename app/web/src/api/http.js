// The one place that talks to the service over HTTP. Same-origin, cookie session, JSON in and out.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when no response arrived (network failure).
   * @param {string} code the service's snake_case `error` code.
   * @param {string|null} reason the service's optional `reason` detail.
   */
  constructor(status, code, reason = null) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

const AUTH_PREFIX = "/api/auth/";
let onUnauthenticated = null;

/**
 * Registers the function called once for every 401 response. Pass null to clear. 401s from `/api/auth/*` never
 * reach it: a wrong password or a spent reset token is not an ended session.
 */
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = typeof fn === "function" ? fn : null;
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} method
 * @param {string} path absolute path starting with /api
 * @param {unknown} [body] sent as JSON when given; no body and no content type otherwise
 * @returns the parsed JSON body (null when empty)
 */
export async function request(method, path, body) {
  const init = { method, credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network_error");
  }

  const data = await readJson(res);
  if (res.ok) return data;

  const code = typeof data?.error === "string" ? data.error : "unknown";
  const reason = typeof data?.reason === "string" ? data.reason : null;
  const error = new ApiError(res.status, code, reason);
  if (res.status === 401 && onUnauthenticated && !path.startsWith(AUTH_PREFIX)) {
    try {
      onUnauthenticated(error);
    } catch {
      /* the handler must never replace the ApiError */
    }
  }
  throw error;
}
