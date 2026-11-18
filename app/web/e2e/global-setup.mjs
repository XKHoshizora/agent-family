// Local mode: build, fresh af_e2e, the model stub and the judgement stub, one service on 127.0.0.1:E2E_PORT whose site
// models and judgement model are the stubs; the returned function is the global teardown (stops the service and the
// stubs, removes the run's temp files). Remote mode: nothing to start (the specs that need the stubs skip themselves).
import { REMOTE } from "./support/env.mjs";
import { startLocalSystem } from "./support/system.mjs";

export default async function globalSetup() {
  if (REMOTE) {
    for (const name of ["E2E_INVITE_CMD", "E2E_INBOX_CMD"]) {
      if (!process.env[name]) throw new Error(`remote mode (E2E_BASE_URL) needs ${name}`);
    }
    return undefined;
  }
  return startLocalSystem();
}
