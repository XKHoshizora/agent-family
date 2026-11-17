import { randomUUID } from "node:crypto";
import { z } from "zod";
import { lockAccount } from "../accounts/store.ts";
import type { Protocol } from "../config.ts";
import type { Queryable, Tx } from "../db.ts";
import { AppError, notFound } from "../errors.ts";
import { userText } from "../schemas.ts";
import { openKey, sealKey } from "./crypto.ts";

/** Providers one person may have. */
export const MAX_PROVIDERS = 10;
/** Models one provider may list. */
export const MAX_MODELS = 100;

/** A model's name: what the provider calls it, 1–100 characters, one line. */
export const modelName = userText(1, 100, { singleLine: true });
export const CONTEXT_TOKENS = { min: 1_000, max: 2_000_000 } as const;

/** What a provider's model can do. Stored as this JSON in `providers.models`, and shown as it is. */
export interface ProviderModel {
  name: string;
  vision: boolean;
  pdf: boolean;
  reasoning: boolean;
  contextTokens: number;
}

const storedModel = z.strictObject({
  name: modelName,
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.boolean(),
  contextTokens: z.number().int().min(CONTEXT_TOKENS.min).max(CONTEXT_TOKENS.max),
});

/**
 * The stored `models` value as a list. Something malformed reads as no models: a value that is not an array is
 * none, and an entry that is not a whole, valid model is left out (as is a second entry of the same name).
 */
export function parseModels(raw: unknown): ProviderModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderModel[] = [];
  for (const entry of raw) {
    const parsed = storedModel.safeParse(entry);
    if (parsed.success && !out.some((m) => m.name === parsed.data.name)) out.push(parsed.data);
  }
  return out;
}

/** A provider as its owner sees it: never the key, only its last four characters. */
export interface ProviderRow {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  keyLast4: string;
  models: ProviderModel[];
}

interface ProviderDbRow {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  key_last4: string;
  models: unknown;
}

/** The columns of `ProviderRow`. `key_cipher` is read by `loadProviderForCall` alone. */
const COLUMNS = "id, name, protocol, base_url, key_last4, models";

const toRow = (r: ProviderDbRow): ProviderRow => ({
  id: r.id,
  name: r.name,
  protocol: r.protocol,
  baseUrl: r.base_url,
  keyLast4: r.key_last4,
  models: parseModels(r.models),
});

/** The last four characters (code points) of a key: all that is ever shown of it. */
const lastFour = (key: string): string => [...key].slice(-4).join("");

const UNIQUE_VIOLATION = "23505";
const nameTaken = () => new AppError(409, "name_taken");

/** Runs an insert or update of `providers`, turning the per-owner name uniqueness into 409 `name_taken`. */
async function uniqueName<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw nameTaken();
    throw err;
  }
}

/** The owner's providers, oldest first. */
export async function listProviders(q: Queryable, ownerId: string): Promise<ProviderRow[]> {
  const { rows } = await q.query<ProviderDbRow>(`select ${COLUMNS} from providers where owner_id = $1 order by created_at, id`, [ownerId]);
  return rows.map(toRow);
}

export interface NewProvider {
  name: string;
  protocol: Protocol;
  /** Already normalised (guard.ts `normaliseBaseUrl`). */
  baseUrl: string;
  apiKey: string;
  models: ProviderModel[];
}

/**
 * Creates a provider with its key sealed under `secret` for the new row (its id is made first: the key is bound to it).
 * The owner's account lock serialises the count, so concurrent creates cannot pass `MAX_PROVIDERS` (400
 * `provider_limit`). 409 `name_taken`.
 */
export async function createProvider(t: Tx, ownerId: string, input: NewProvider, secret: string): Promise<ProviderRow> {
  await lockAccount(t, ownerId);
  const { rows: count } = await t.query<{ n: number }>("select count(*)::int as n from providers where owner_id = $1", [ownerId]);
  if (count[0]!.n >= MAX_PROVIDERS) throw new AppError(400, "provider_limit");
  const id = randomUUID();
  const sealed = sealKey(input.apiKey, secret, { ownerId, providerId: id });
  const { rows } = await uniqueName(() =>
    t.query<ProviderDbRow>(
      `insert into providers (id, owner_id, name, protocol, base_url, key_cipher, key_last4, models)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning ${COLUMNS}`,
      [id, ownerId, input.name, input.protocol, input.baseUrl, sealed, lastFour(input.apiKey), JSON.stringify(input.models)],
    ),
  );
  return toRow(rows[0]!);
}

/**
 * Locks the owner's provider row (`for no key update`: an Agent may still take it meanwhile, a delete may not) and
 * returns it; 404 when there is none, or it is someone else's.
 */
async function lockOwnedProvider(t: Tx, ownerId: string, id: string): Promise<ProviderRow> {
  const { rows } = await t.query<ProviderDbRow>(`select ${COLUMNS} from providers where id = $1 and owner_id = $2 for no key update`, [id, ownerId]);
  if (!rows[0]) throw notFound();
  return toRow(rows[0]);
}

export interface ProviderPatch {
  name?: string;
  /** Already normalised. */
  baseUrl?: string;
  /** A new key, sealed again; absent: the stored one stays. */
  apiKey?: string;
  /** Replaces the list. */
  models?: ProviderModel[];
}

/** A base URL's origin (scheme, host and port); null when it does not parse (then it counts as another origin). */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Edits the owner's provider; the protocol never changes. 404 when it is not theirs, 409 `name_taken`. A `baseUrl` on
 * another origin (scheme, host or port) than the stored one is 400 `invalid_request` unless the same edit carries the
 * key: the stored key is never sent to an address its owner did not save it for. A path change keeps it.
 */
export async function updateProvider(t: Tx, ownerId: string, id: string, patch: ProviderPatch, secret: string): Promise<ProviderRow> {
  const current = await lockOwnedProvider(t, ownerId, id);
  if (patch.baseUrl !== undefined && patch.apiKey === undefined) {
    const next = originOf(patch.baseUrl);
    if (next === null || next !== originOf(current.baseUrl)) throw new AppError(400, "invalid_request");
  }
  const name = patch.name ?? current.name;
  const baseUrl = patch.baseUrl ?? current.baseUrl;
  const models = patch.models ?? current.models;
  const { rows } = await uniqueName(() =>
    patch.apiKey === undefined
      ? t.query<ProviderDbRow>(`update providers set name = $2, base_url = $3, models = $4::jsonb where id = $1 returning ${COLUMNS}`, [
          id,
          name,
          baseUrl,
          JSON.stringify(models),
        ])
      : t.query<ProviderDbRow>(
          `update providers set name = $2, base_url = $3, models = $4::jsonb, key_cipher = $5, key_last4 = $6 where id = $1 returning ${COLUMNS}`,
          [id, name, baseUrl, JSON.stringify(models), sealKey(patch.apiKey, secret, { ownerId, providerId: current.id }), lastFour(patch.apiKey)],
        ),
  );
  return toRow(rows[0]!);
}

/**
 * Adds the names a provider listed to its models (new ones with conservative defaults: no vision, no PDF, no
 * reasoning, `defaultContextTokens`), keeping every model already there with its flags, up to `MAX_MODELS`.
 */
export async function mergeListedModels(t: Tx, ownerId: string, id: string, names: string[], defaultContextTokens: number): Promise<ProviderRow> {
  const current = await lockOwnedProvider(t, ownerId, id);
  const models = [...current.models];
  const known = new Set(models.map((m) => m.name));
  for (const name of names) {
    if (models.length >= MAX_MODELS) break;
    if (known.has(name)) continue;
    known.add(name);
    models.push({ name, vision: false, pdf: false, reasoning: false, contextTokens: defaultContextTokens });
  }
  const { rows } = await t.query<ProviderDbRow>(`update providers set models = $2::jsonb where id = $1 returning ${COLUMNS}`, [id, JSON.stringify(models)]);
  return toRow(rows[0]!);
}

/**
 * Deletes the owner's provider. Refused (409 `provider_in_use`, with the Agents) while an Agent that is not deleted
 * uses it; deleted Agents that still name it lose their model. The row is locked `for update` first, so an Agent
 * cannot take it meanwhile (`lockProviderModels` waits, then finds nothing). 404 when it is not theirs.
 */
export async function deleteProvider(t: Tx, ownerId: string, id: string): Promise<void> {
  const { rows: found } = await t.query("select 1 from providers where id = $1 and owner_id = $2 for update", [id, ownerId]);
  if (found.length === 0) throw notFound();
  const { rows: users } = await t.query<{ id: string; name: string }>(
    `select p.id, p.display_name as name
       from agents a join principals p on p.id = a.principal_id
      where a.provider_id = $1 and a.deleted_at is null
      order by a.created_at, p.id`,
    [id],
  );
  if (users.length > 0) throw new AppError(409, "provider_in_use", { agents: users.map((u) => ({ id: u.id, name: u.name })) });
  await t.query(
    "update agents set model_source = null, provider_id = null, provider_model = null where provider_id = $1 and deleted_at is not null",
    [id],
  );
  await t.query("delete from providers where id = $1", [id]);
}

/**
 * The models of the owner's provider, or null when there is no such provider of theirs. Takes a `for key share`
 * lock: inside a transaction that is about to point an Agent at it, a concurrent delete waits until it is done (and
 * is then refused), or has already removed it (and this finds nothing).
 */
export async function lockProviderModels(q: Queryable, ownerId: string, providerId: string): Promise<ProviderModel[] | null> {
  const { rows } = await q.query<{ models: unknown }>("select models from providers where id = $1 and owner_id = $2 for key share", [providerId, ownerId]);
  return rows[0] ? parseModels(rows[0].models) : null;
}

/**
 * What calling the owner's provider takes, its key in plaintext; null when there is no such provider of theirs.
 * The one reader of a key outside crypto.ts: it goes straight to the upstream call and nowhere else. A key that
 * cannot be opened — another `PROVIDER_KEY_SECRET`, or a value sealed for another row (it is opened as this row's,
 * by the owner and id stored on it) — throws `KeyUnreadableError`.
 */
export async function loadProviderForCall(
  q: Queryable,
  ownerId: string,
  providerId: string,
  secret: string,
): Promise<{ protocol: Protocol; baseUrl: string; apiKey: string; models: ProviderModel[] } | null> {
  const { rows } = await q.query<{ id: string; owner_id: string; protocol: Protocol; base_url: string; key_cipher: Buffer; models: unknown }>(
    "select id, owner_id, protocol, base_url, key_cipher, models from providers where id = $1 and owner_id = $2",
    [providerId, ownerId],
  );
  const r = rows[0];
  if (!r) return null;
  const apiKey = openKey(r.key_cipher, secret, { ownerId: r.owner_id, providerId: r.id });
  return { protocol: r.protocol, baseUrl: r.base_url, apiKey, models: parseModels(r.models) };
}
