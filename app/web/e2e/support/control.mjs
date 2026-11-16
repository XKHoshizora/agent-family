// Stopping and starting the local service from a test (the runner process owns it; see system.mjs).
import { REMOTE } from "./env.mjs";

/** Only the local suite controls the service process. */
export const canControlService = !REMOTE && Boolean(process.env.E2E_CONTROL_URL);

async function step(name) {
  if (!canControlService) throw new Error("the service process is not controlled by this run");
  const res = await fetch(`${process.env.E2E_CONTROL_URL}/${name}`, {
    method: "POST",
    headers: { "x-e2e-token": process.env.E2E_CONTROL_TOKEN },
  });
  if (res.status !== 204) throw new Error(`service ${name} failed: ${await res.text()}`);
}

/** Ends the service process (a hard stop) and waits until its port is free. */
export const stopService = () => step("stop");
/** Starts it again with the same configuration, database and blobs; resolves once /api/health answers. */
export const startService = () => step("start");
