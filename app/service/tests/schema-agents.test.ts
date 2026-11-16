import { describe, expect, test } from "vitest";
import { useApp } from "./helpers/harness.ts";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

describe("agent, provider, metering and run tables", () => {
  const { db } = useApp();

  async function human(handle: string): Promise<string> {
    await db.query(
      `insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`,
      [`auth-${handle}`],
    );
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, auth_user_id)
       values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`,
      [handle],
    );
    return rows[0]!.id;
  }

  async function agentPrincipal(owner: string, handle: string): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into principals (kind, handle, display_name, owner_id) values ('agent', $1::citext, $1::text, $2) returning id`,
      [handle, owner],
    );
    return rows[0]!.id;
  }

  async function provider(owner: string, name = "mine"): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4)
       values ($1, $2, 'openai_chat', 'https://api.example.test/v1', '\\x00', 'abcd') returning id`,
      [owner, name],
    );
    return rows[0]!.id;
  }

  async function rejectedWith(code: string, sql: string, params: unknown[] = []): Promise<void> {
    await expect(db.query(sql, params)).rejects.toMatchObject({ code });
  }

  test("an agents row for a human principal is rejected; for an agent principal it gets its defaults", async () => {
    const owner = await human("owner_a");
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into agents (principal_id) values ($1)`, [owner]);
    const agent = await agentPrincipal(owner, "bot_a");
    await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
    const { rows } = await db.query(
      `select intro, field, persona, persona_version, reply_mode, reasoning, model_source, paused, deleted_at from agents`,
    );
    expect(rows).toEqual([
      { intro: "", field: "", persona: "", persona_version: 0, reply_mode: "always", reasoning: "none", model_source: null, paused: false, deleted_at: null },
    ]);
  });

  test("the model columns must agree with model_source", async () => {
    const owner = await human("owner_b");
    const prov = await provider(owner);
    const insert = async (handle: string, cols: string, vals: string, params: unknown[] = []) => {
      const id = await agentPrincipal(owner, handle);
      return db.query(`insert into agents (principal_id, ${cols}) values ($1, ${vals})`, [id, ...params]);
    };
    await expect(insert("bad_site_prov", "model_source, site_model_id, provider_id", `'site', 'fast', $2`, [prov])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_site_none", "model_source", `'site'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_prov_none", "model_source", `'provider'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_prov_site", "model_source, provider_id, provider_model, site_model_id", `'provider', $2, 'm', 'fast'`, [prov])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_null_src", "site_model_id", `'fast'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await expect(insert("bad_mode", "reply_mode", `'sometimes'`)).rejects.toMatchObject({ code: CHECK_VIOLATION });
    await insert("good_site", "model_source, site_model_id", `'site', 'fast'`);
    await insert("good_prov", "model_source, provider_id, provider_model", `'provider', $2, 'm'`, [prov]);
  });

  test("a provider in use by an agent cannot be deleted; names are unique per owner", async () => {
    const owner = await human("owner_c");
    const other = await human("owner_d");
    const prov = await provider(owner);
    await rejectedWith(
      UNIQUE_VIOLATION,
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4) values ($1, 'mine', 'gemini', 'https://x.test', '\\x00', 'abcd')`,
      [owner],
    );
    await provider(other); // same name, other owner: fine
    await rejectedWith(
      CHECK_VIOLATION,
      `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4) values ($1, 'odd', 'smoke_signal', 'https://x.test', '\\x00', 'abcd')`,
      [owner],
    );
    const agent = await agentPrincipal(owner, "bot_c");
    await db.query(`insert into agents (principal_id, model_source, provider_id, provider_model) values ($1, 'provider', $2, 'm')`, [agent, prov]);
    await rejectedWith(FOREIGN_KEY_VIOLATION, `delete from providers where id = $1`, [prov]);
  });

  test("conversations.type accepts 'agent'; an agent has one conversation row", async () => {
    const owner = await human("owner_e");
    const agent = await agentPrincipal(owner, "bot_e");
    await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
    const first = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
    await db.query(`insert into agent_conversations (conversation_id, agent_id, owner_id) values ($1, $2, $3)`, [first.rows[0]!.id, agent, owner]);
    const second = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
    await rejectedWith(UNIQUE_VIOLATION, `insert into agent_conversations (conversation_id, agent_id, owner_id) values ($1, $2, $3)`, [second.rows[0]!.id, agent, owner]);
    await rejectedWith(CHECK_VIOLATION, `insert into conversations (type, creator_id) values ('channel', $1)`, [owner]);
  });

  test("principals.avatar_version starts at 0", async () => {
    const owner = await human("owner_f");
    expect((await db.query(`select avatar_version from principals where id = $1`, [owner])).rows).toEqual([{ avatar_version: 0 }]);
  });

  test("accounts may go negative (one reply of debt); ledger, usage and free-usage rows keep their shape", async () => {
    const owner = await human("owner_g");
    await db.query(`insert into accounts (principal_id) values ($1)`, [owner]);
    await db.query(`update accounts set balance_micro = -5000000 where principal_id = $1`, [owner]);
    expect((await db.query(`select tier, balance_micro::text as b from accounts`)).rows).toEqual([{ tier: "free", b: "-5000000" }]);
    const usageSql = (outcome: string, purpose = "draft") =>
      `insert into usage_records (owner_id, purpose, source, model, input_tokens, output_tokens, estimated, cost_micro, free_micro, balance_micro, forgiven_micro, outcome)
       values ($1, '${purpose}', 'site', 'fast', 10, 20, false, 70, 0, 70, 0, '${outcome}') returning id::text`;
    const usage = await db.query<{ id: string }>(usageSql("done"), [owner]);
    await db.query(`insert into balance_ledger (owner_id, delta_micro, reason, note, usage_id) values ($1, -70, 'usage', null, $2)`, [owner, usage.rows[0]!.id]);
    await rejectedWith(CHECK_VIOLATION, `insert into balance_ledger (owner_id, delta_micro, reason) values ($1, 1, 'gift')`, [owner]);
    await rejectedWith(CHECK_VIOLATION, usageSql("exploded"), [owner]);
    await rejectedWith(CHECK_VIOLATION, usageSql("done", "chat"), [owner]);
    await db.query(`insert into free_usage (owner_id, day, used_micro) values ($1, '2026-11-16', 5)`, [owner]);
    await rejectedWith(UNIQUE_VIOLATION, `insert into free_usage (owner_id, day, used_micro) values ($1, '2026-11-16', 6)`, [owner]);
    await rejectedWith(FOREIGN_KEY_VIOLATION, `insert into accounts (principal_id) values (gen_random_uuid())`);
  });

  describe("agent_runs and persona_proposals", () => {
    async function setup(): Promise<{ owner: string; agent: string; conversation: string }> {
      const owner = await human("owner_h");
      const agent = await agentPrincipal(owner, "bot_h");
      await db.query(`insert into agents (principal_id) values ($1)`, [agent]);
      const { rows } = await db.query<{ id: string }>(`insert into conversations (type, creator_id) values ('agent', $1) returning id`, [owner]);
      return { owner, agent, conversation: rows[0]!.id };
    }
    const runSql = `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq) values ('reply', $1, $2, $3, $4, 1)`;

    test("two active runs for one agent fail on the partial index; a done plus a queued succeed", async () => {
      const { owner, agent, conversation } = await setup();
      await db.query(runSql, [conversation, agent, owner, "done"]);
      await db.query(runSql, [conversation, agent, owner, "queued"]);
      await rejectedWith(UNIQUE_VIOLATION, runSql, [conversation, agent, owner, "running"]);
      await db.query(`update agent_runs set status = 'failed' where status = 'queued'`);
      await db.query(runSql, [conversation, agent, owner, "running"]);
      await rejectedWith(CHECK_VIOLATION, runSql, [conversation, agent, owner, "sleeping"]);
    });

    test("a reply run needs both conversation and agent; a draft run has neither", async () => {
      const { owner, agent, conversation } = await setup();
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, owner_id, status) values ('reply', $1, 'queued')`, [owner]);
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, agent_id, owner_id, status) values ('reply', $1, $2, 'queued')`, [agent, owner]);
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, conversation_id, owner_id, status) values ('reply', $1, $2, 'queued')`, [conversation, owner]);
      await rejectedWith(CHECK_VIOLATION, `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status) values ('draft', $1, $2, $3, 'running')`, [conversation, agent, owner]);
      await db.query(`insert into agent_runs (purpose, owner_id, status, source, model, charge_to, hold_micro) values ('draft', $1, 'running', 'site', 'fast', 'free', 1000)`, [owner]);
      await db.query(`insert into agent_runs (purpose, owner_id, status) values ('draft', $1, 'running')`, [owner]); // drafts are not limited by the per-agent index
      expect((await db.query(`select hold_micro::text as h from agent_runs order by hold_micro desc`)).rows[0]).toEqual({ h: "1000" });
    });

    test("a run's recorded model: source and model together, and a charge exactly when it is a site model's call", async () => {
      const { owner } = await setup();
      const draft = (cols: string, vals: string) =>
        `insert into agent_runs (purpose, owner_id, status, ${cols}) values ('draft', $1, 'running', ${vals})`;
      for (const [cols, vals] of [
        ["source", "'site'"], // no model
        ["model", "'fast'"], // no source
        ["source, model", "'cloud', 'fast'"],
        ["source, model", "'site', 'fast'"], // a site call charged to nothing
        ["source, model, charge_to", "'provider', 'm', 'free'"], // a provider call charged
        ["charge_to", "'balance'"], // charged without a model
      ] as const) {
        await rejectedWith(CHECK_VIOLATION, draft(cols, vals), [owner]);
      }
      await db.query(draft("source, model, charge_to, hold_micro", "'site', 'fast', 'balance', 5"), [owner]);
      await db.query(draft("source, model", "'provider', 'm'"), [owner]);
      await db.query(`insert into agent_runs (purpose, owner_id, status) values ('draft', $1, 'queued')`, [owner]); // not admitted: neither
      expect((await db.query("select count(*)::int n from agent_runs")).rows).toEqual([{ n: 3 }]);
    });

    test("a usage record may lack a model only together with its source, and then costs nothing", async () => {
      const { owner } = await setup();
      const usage = `insert into usage_records (owner_id, purpose, source, model, cost_micro, outcome) values ($1, 'draft', $2, $3, $4, 'failed')`;
      await db.query(usage, [owner, null, null, 0]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, null, null, 5]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, "site", null, 0]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, null, "fast", 0]);
      await rejectedWith(CHECK_VIOLATION, usage, [owner, "cloud", "fast", 0]);
    });

    test("persona proposals reference a message and have a status", async () => {
      const { agent, conversation } = await setup();
      const message = await db.query<{ id: string }>(
        `insert into messages (conversation_id, seq, sender_id, kind, body) values ($1, 1, $2, 'text', '{}') returning id::text`,
        [conversation, agent],
      );
      const messageId = message.rows[0]!.id;
      await db.query(`insert into persona_proposals (agent_id, message_id, base_persona_version, persona) values ($1, $2, 0, 'be nice')`, [agent, messageId]);
      expect((await db.query(`select status from persona_proposals`)).rows).toEqual([{ status: "open" }]);
      await rejectedWith(CHECK_VIOLATION, `insert into persona_proposals (agent_id, message_id, base_persona_version, persona, status) values ($1, $2, 0, 'x', 'maybe')`, [agent, messageId]);
    });
  });
});
