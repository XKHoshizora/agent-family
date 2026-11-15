import { config as loadDotenv } from "dotenv";
import { createBlobStore } from "./attachments/blob.ts";
import { abandonedAfterMs, sweepPendingBlobs } from "./attachments/pending.ts";
import { sweepOrphans } from "./attachments/store.ts";
import { createInvite } from "./auth/invites.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db.ts";
import { runMigrations } from "./migrate.ts";

loadDotenv({ quiet: true });

const USAGE =
  "usage: cli.ts migrate | invite:create [--ttl-hours <n>] | inbox:list [--to <email>] | attachments:sweep [--older-than <minutes>]";

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

const [command, ...args] = process.argv.slice(2);

if (command === "migrate") {
  await runMigrations(databaseUrl());
} else if (command === "invite:create") {
  const ttlHours = Number(flag(args, "--ttl-hours") ?? 72);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error("--ttl-hours must be a positive number");
  const db = createDb(databaseUrl());
  try {
    console.log(await createInvite(db, { ttlHours }));
  } finally {
    await db.close();
  }
} else if (command === "inbox:list") {
  const to = flag(args, "--to");
  const db = createDb(databaseUrl());
  try {
    const { rows } = await db.query<{ id: string; created_at: Date; recipient: string; kind: string; subject: string; body: string }>(
      `select id, created_at, recipient, kind, subject, body from mail_outbox
        where ($1::text is null or recipient = lower($1::text)) order by id`,
      [to ?? null],
    );
    for (const m of rows) {
      console.log(`#${m.id} ${m.created_at.toISOString()} to=${m.recipient} kind=${m.kind}\n  ${m.subject}\n${m.body.split("\n").map((line) => `  ${line}`).join("\n")}\n`);
    }
  } finally {
    await db.close();
  }
} else if (command === "attachments:sweep") {
  // Uploads never sent in a message. Run it periodically (cron); it is safe to run at any time.
  const raw = flag(args, "--older-than") ?? "60";
  if (!/^\d+$/.test(raw)) throw new Error("--older-than must be a whole number of minutes");
  const olderThan = Number(raw);
  const config = loadConfig(); // the blob store settings, as the server uses them
  const db = createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs });
  try {
    const deps = { db, blobs: createBlobStore(config) };
    const swept = await sweepOrphans(deps, olderThan, {
      error: ({ err, attachmentId }, msg) => console.error(`${msg} (attachment ${attachmentId}): ${String(err)}`),
    });
    // Also blobs no row came to reference: refused uploads whose delete failed, uploads cut off or
    // interrupted by a crash, replaced avatars. Only once they are past the upload deadline.
    const abandoned = await sweepPendingBlobs(deps, abandonedAfterMs(config), {
      error: ({ err, key }, msg) => console.error(`${msg} (blob ${key}): ${String(err)}`),
    });
    console.log(`swept ${swept} unsent attachment(s) older than ${olderThan} minutes and ${abandoned} abandoned blob(s)`);
  } finally {
    await db.close();
  }
} else {
  console.error(USAGE);
  process.exit(1);
}
