// What a test asks of the runner process (it owns the local service and the model stub; see system.mjs).
import { REMOTE } from "./env.mjs";

/** Only the local suite controls the service process (and has a model stub). */
export const canControlService = !REMOTE && Boolean(process.env.E2E_CONTROL_URL);

/** POSTs `body` (JSON) to the control endpoint's `path`; resolves with its JSON answer (null for none). */
export async function controlCall(path, body) {
  if (!canControlService) throw new Error("the service process is not controlled by this run");
  const res = await fetch(`${process.env.E2E_CONTROL_URL}/${path}`, {
    method: "POST",
    headers: { "x-e2e-token": process.env.E2E_CONTROL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`control ${path} failed: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Ends the service process (a hard stop) and waits until its port is free. */
export const stopService = () => controlCall("stop");
/** Starts it again with the same configuration, database and blobs; resolves once /api/health answers. */
export const startService = () => controlCall("start");
/**
 * Stops it and starts it again with `env` over its configuration (only what system.mjs lets a spec set, e.g.
 * `{AGENT_CHAIN_LIMIT: "3"}`); `restartService({})` is its own configuration again. Resolves once /api/health answers.
 */
export const restartService = (env = {}) => controlCall("restart", { env });
