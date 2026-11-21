import { config as loadDotenv } from "dotenv";
import { createBlobStore } from "./attachments/blob.ts";
import { DEFAULT_UNSENT_AFTER_MINUTES, runSweep } from "./attachments/sweeper.ts";
import { applyLedger, ensureAccount, formatPoints, lockAccount, parsePoints } from "./accounts/store.ts";
import { createInvite } from "./auth/invites.ts";
import { loadConfig } from "./config.ts";
import { createDb, type Db } from "./db.ts";
import { configureStats, formatStats, readStats } from "./memory/stats.ts";
import { CHANGE_KEEP_DAYS, sweepMemoryChanges } from "./memory/sweep.ts";
import { expireWhispers, removeOldWhispers, WHISPER_KEEP_DAYS, WHISPER_OPEN_DAYS } from "./whispers/store.ts";
import { deliverReminders } from "./metering/reminders.ts";
import { runMigrations } from "./migrate.ts";

loadDotenv({ quiet: true });

const USAGE =
  "usage: cli.ts migrate | invite:create [--ttl-hours <n>] | inbox:list [--to <email>] | attachments:sweep [--older-than <minutes>] | " +
  "credits:grant --handle <h> --points <n> [--note <text>] | credits:show --handle <h> | tier:set --handle <h> --tier <name> | models:list | memory:stats [--days <n>]";

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

/** The person (never an Agent: accounts belong to humans) whose handle is given. */
async function humanByHandle(db: Db, handle: string): Promise<{ id: string; handle: string }> {
  const { rows } = await db.query<{ id: string; handle: string; kind: string }>(
    "select id, handle::text as handle, kind from principals where handle = $1",
    [handle],
  );
  const row = rows[0];
  if (!row) throw new Error(`no such handle: ${handle}`);
  if (row.kind !== "human") throw new Error(`${row.handle} is an Agent; accounts belong to people`);
  return row;
}

function requiredFlag(args: string[], name: string): string {
  const value = flag(args, name);
  if (value === undefined) throw new Error(`${name} is required`);
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
  // The server runs this on a timer itself (SWEEP_INTERVAL_MINUTES); this is for running it by hand.
  const raw = flag(args, "--older-than") ?? String(DEFAULT_UNSENT_AFTER_MINUTES);
  if (!/^\d+$/.test(raw)) throw new Error("--older-than must be a whole number of minutes");
  const olderThan = Number(raw);
  const config = loadConfig(); // the blob store settings, as the server uses them
  const db = createDb(config.databaseUrl, { statementTimeoutMs: config.dbStatementTimeoutMs, acquireTimeoutMs: config.dbAcquireTimeoutMs });
  // What it counts (the cards it discards, `card_expired`) is counted on the site's day, as the server counts it.
  configureStats({ siteTimezone: config.siteTimezone, log: null });
  try {
    const log = {
      error: ({ err, ...what }: Record<string, unknown>, msg: string) =>
        console.error(`${msg} (${Object.entries(what).map(([k, v]) => `${k} ${String(v)}`).join(", ")}): ${String(err)}`),
    };
    const { unsent, abandoned } = await runSweep({ db, blobs: createBlobStore(config) }, config, log, olderThan);
    console.log(`swept ${unsent} unsent attachment(s) older than ${olderThan} minutes and ${abandoned} abandoned blob(s)`);
    // The record of what memory changed too (kept 30 days): the server does this on its own timer as well.
    const changes = await sweepMemoryChanges(db);
    console.log(`swept ${changes.deleted} memory change record(s) older than ${CHANGE_KEEP_DAYS} days and discarded ${changes.discarded} that nobody answered`);
    // And the whispers left open (the server does this on the same timer; their owners are told at their next sync), and the old answered ones.
    const whispers = await expireWhispers(db);
    console.log(`expired ${whispers.length} whisper(s) left open ${WHISPER_OPEN_DAYS} days`);
    const removed = await removeOldWhispers(db);
    console.log(`deleted ${removed} answered or expired whisper(s) made ${WHISPER_KEEP_DAYS} days ago`);
    // And the reminders about money a settlement recorded but whose whisper was never made (their owners see them at their next sync).
    const reminded = await deliverReminders(db, config, { warn: (what, msg) => console.error(`${msg} (code ${String(what.code)})`) });
    console.log(`made ${reminded.filter((r) => r.whisper).length} reminder(s) about money left undelivered (${reminded.filter((r) => !r.whisper).length} of owners with no Agent left)`);
  } finally {
    await db.close();
  }
} else if (command === "credits:grant" || command === "credits:show" || command === "tier:set") {
  const handle = requiredFlag(args, "--handle");
  // Every argument is checked before the database is touched.
  let micro = 0n;
  if (command === "credits:grant") {
    const parsed = parsePoints(requiredFlag(args, "--points"));
    if (parsed === null || parsed === 0n) {
      throw new Error("--points must be a non-zero decimal number with at most 6 fraction digits (negative takes points back)");
    }
    micro = parsed;
  }
  let tier = "";
  if (command === "tier:set") {
    tier = requiredFlag(args, "--tier");
    const known = Object.keys(loadConfig().agentTiers);
    if (!known.includes(tier)) throw new Error(`unknown tier "${tier}"; AGENT_TIERS has: ${known.join(", ")}`);
  }
  const db = createDb(databaseUrl());
  try {
    const person = await humanByHandle(db, handle);
    if (command === "credits:grant") {
      const note = flag(args, "--note") ?? null;
      const balance = await db.tx(async (t) => {
        await lockAccount(t, person.id);
        // Taking points back is an adjustment, not a grant.
        return applyLedger(t, person.id, micro, micro < 0n ? "adjust" : "grant", note);
      });
      console.log(formatPoints(balance));
    } else if (command === "tier:set") {
      await db.tx(async (t) => {
        await ensureAccount(t, person.id);
        await t.query("update accounts set tier = $2 where principal_id = $1", [person.id, tier]);
      });
      console.log(`${person.handle} is now on tier ${tier}`);
    } else {
      const { rows } = await db.query<{ tier: string; balance_micro: string }>(
        "select tier, balance_micro::text from accounts where principal_id = $1",
        [person.id],
      );
      const row = rows[0];
      console.log(`${person.handle}\ntier ${row?.tier ?? "free"}\nbalance ${formatPoints(BigInt(row?.balance_micro ?? "0"))}`);
    }
  } finally {
    await db.close();
  }
} else if (command === "models:list") {
  // Prices are micro-points per token. The upstream key (apiKeyEnv) is deliberately never read or printed.
  for (const m of loadConfig().siteModels) {
    console.log(`${m.id}  "${m.label}"  tier ${m.tier}  protocol ${m.protocol}  in ${m.inputMicroPerToken}  out ${m.outputMicroPerToken}  (micro-points per token)`);
  }
} else if (command === "memory:stats") {
  // The memory counters (README "Memory counters"): counts only, no owner, conversation or text; days as columns.
  const days = Number(flag(args, "--days") ?? "7");
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("--days needs a whole number from 1 to 366");
  const db = createDb(databaseUrl());
  try {
    console.log(formatStats(await readStats(db, days), days));
  } finally {
    await db.close();
  }
} else {
  console.error(USAGE);
  process.exit(1);
}
