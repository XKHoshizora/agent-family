// Direct changes to the local suite's own database (af_e2e) for what no person can do in the app, such as a message
// sent yesterday. Local mode only; the connection is refused unless it really is af_e2e.
import { createRequire } from "node:module";
import path from "node:path";
import { E2E_DATABASE, REMOTE, SERVICE_DIR, e2eDatabaseUrl } from "./env.mjs";

/** Runs `work(client)` on a connection to af_e2e; resolves with what it returns. */
async function withDatabase(work) {
  if (REMOTE) throw new Error("the database is reachable only in the local suite");
  const pg = createRequire(path.join(SERVICE_DIR, "package.json"))("pg");
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query("select current_database() as name");
    if (rows[0].name !== E2E_DATABASE) throw new Error(`refusing to change database ${rows[0].name}`);
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * Moves message `seq` of conversation `conversationId` `days` whole days into the past (as if it had been sent then);
 * resolves with its new time (an ISO string).
 */
export function backdateMessage(conversationId, seq, days) {
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(days) || days < 1) throw new Error("a message seq and a whole number of days");
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      "update messages set created_at = created_at - make_interval(days => $3) where conversation_id = $1 and seq = $2 returning created_at",
      [conversationId, seq, days],
    );
    if (rows.length !== 1) throw new Error("no such message");
    return rows[0].created_at.toISOString();
  });
}
