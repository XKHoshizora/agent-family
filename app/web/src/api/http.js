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
let sessionEpoch = 0;

/** A new session or the end of one: 401s of requests that started before this are about the old session. */
export function bumpSessionEpoch() {
  sessionEpoch += 1;
}

/**
 * Registers the function called once for every 401 response. Pass null to clear. 401s from `/api/auth/*` never
 * reach it: a wrong password or a spent reset token is not an ended session.
 */
export function setUnauthenticatedHandler(fn) {
  onUnauthenticated = typeof fn === "function" ? fn : null;
}

async function readJson(res) {
  return parseJson(await res.text());
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

  const epoch = sessionEpoch;
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, "network_error");
  }

  const data = await readJson(res);
  if (res.ok) return data;

  throw apiErrorOf(res.status, data, path, epoch);
}

/** The ApiError for a non-2xx answer; a 401 on a non-auth path first reaches the registered handler. */
function apiErrorOf(status, data, path, epoch) {
  const code = typeof data?.error === "string" ? data.error : "unknown";
  const reason = typeof data?.reason === "string" ? data.reason : null;
  const error = new ApiError(status, code, reason);
  if (status === 401 && onUnauthenticated && epoch === sessionEpoch && !path.startsWith(AUTH_PREFIX)) {
    try {
      onUnauthenticated(error);
    } catch {
      /* the handler must never replace the ApiError */
    }
  }
  return error;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * POSTs a FormData (a multipart upload) with progress. Same origin, so the session cookie goes along; no
 * Content-Type is set (the browser adds the multipart boundary). Errors are ApiErrors as in `request`;
 * aborting through `signal` rejects with `ApiError(0, "aborted")`.
 * @param {string} path absolute path starting with /api
 * @param {FormData} form
 * @param {{onProgress?: (fraction: number) => void, signal?: AbortSignal}} [options]
 * @returns the parsed JSON body
 */
export function upload(path, form, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError(0, "aborted"));
      return;
    }
    const epoch = sessionEpoch;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      const data = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(apiErrorOf(xhr.status, data, path, epoch));
    };
    xhr.onerror = () => reject(new ApiError(0, "network_error"));
    xhr.onabort = () => reject(new ApiError(0, "aborted"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}
