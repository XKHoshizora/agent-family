// Family relationship store: independent Agent registry, friendships,
// directional blocks and supervised AF rooms (DM + 2-5 Agent groups).
// Central, single-instance supervision only (no Matrix / E2EE claims).
import crypto from "node:crypto";
import { db, audit, createRoom, getRoom } from "./db";
import { id, now } from "./config";
import type { Agent } from "../shared/types";
import {
  FAMILY_LIMITS,
  type FamilyAgentColor,
  type FamilyAgentCreate,
  type FamilyAgentOwnerView,
  type FamilyAgentPublicView,
  type FamilyAgentUpdate,
  type FamilyBlockCreate,
  type FamilyBlockView,
  type FamilyErrorCode,
  type FamilyExpand,
  type FamilyFriendshipView,
  type FamilyGroupCreate,
  type FamilyGroupStatus,
  type FamilyGroupView,
  type FamilyOwnerIdentity,
  type FamilyRoomPolicy,
  type FamilySnapshotMember,
} from "../shared/family";

db.exec(`
CREATE TABLE IF NOT EXISTS family_agents(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id TEXT NOT NULL, owner_name TEXT NOT NULL, name TEXT NOT NULL,
  model TEXT NOT NULL, provider TEXT NOT NULL, persona TEXT NOT NULL,
  color TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS family_agents_ws ON family_agents(workspace_id, owner_user_id);
CREATE TRIGGER IF NOT EXISTS family_agents_owner_immutable
  BEFORE UPDATE OF owner_user_id, workspace_id ON family_agents
  WHEN NEW.owner_user_id IS NOT OLD.owner_user_id OR NEW.workspace_id IS NOT OLD.workspace_id
  BEGIN SELECT RAISE(ABORT, 'family agent owner is immutable'); END;
CREATE TABLE IF NOT EXISTS family_friendships(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent_a TEXT NOT NULL REFERENCES family_agents(id),
  agent_b TEXT NOT NULL REFERENCES family_agents(id), requester_agent_id TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK(agent_a < agent_b));
CREATE UNIQUE INDEX IF NOT EXISTS family_friendships_open
  ON family_friendships(agent_a, agent_b) WHERE status IN ('pending','accepted');
CREATE TABLE IF NOT EXISTS family_blocks(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, blocker_user_id TEXT NOT NULL,
  scope TEXT NOT NULL, target_agent_id TEXT NOT NULL, target_user_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, removed_at TEXT);
CREATE INDEX IF NOT EXISTS family_blocks_blocker ON family_blocks(blocker_user_id, removed_at);
CREATE TABLE IF NOT EXISTS family_groups(
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  members TEXT NOT NULL, owners TEXT NOT NULL, snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
  revision INTEGER NOT NULL, status TEXT NOT NULL, room_id TEXT UNIQUE REFERENCES rooms(id),
  parent_group_id TEXT, created_by TEXT NOT NULL, client_request_id TEXT,
  approvals TEXT NOT NULL DEFAULT '{}', causes TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, hash_salt TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS family_groups_idem
  ON family_groups(workspace_id, created_by, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS family_member_tags(
  workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, tag TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, user_id));
CREATE UNIQUE INDEX IF NOT EXISTS family_member_tags_unique ON family_member_tags(workspace_id, tag);
`);
// Additive migration for databases created before the per-group hash salt.
if (
  !(db.pragma("table_info(family_groups)") as { name: string }[]).some(
    (c) => c.name === "hash_salt",
  )
)
  db.exec("ALTER TABLE family_groups ADD COLUMN hash_salt TEXT");

export class FamilyError extends Error {
  constructor(
    public statusCode: number,
    public code: FamilyErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const fail = (
  status: number,
  code: FamilyErrorCode,
  message: string,
): never => {
  throw new FamilyError(status, code, message);
};
const UNAVAILABLE = "暂时不可用。";
const unavailable = () => fail(409, "unavailable", UNAVAILABLE);
const notFound = () => fail(404, "not_found", "内容不存在或你没有访问权限。");

export type FamilyActor = {
  userId: string;
  userName: string;
  workspaceId: string;
  role: string;
};

// ---------- cancel hook (injected by registerFamilyRoutes / Codex) ----------
let cancelHook: ((roomId: string) => void) | undefined;
export function setFamilyCancelHook(fn?: (roomId: string) => void) {
  cancelHook = fn;
}
let txDepth = 0;
let pendingCancels: string[] = [];
function tx<T>(fn: () => T): T {
  txDepth++;
  let result: T;
  try {
    result = db.transaction(fn)();
  } catch (error) {
    txDepth--;
    if (txDepth === 0) pendingCancels = [];
    throw error;
  }
  txDepth--;
  if (txDepth === 0) {
    const rooms = [...new Set(pendingCancels)];
    pendingCancels = [];
    for (const roomId of rooms) {
      try {
        cancelHook?.(roomId);
      } catch {
        /* cancellation is best effort; the run boundary re-checks */
      }
    }
  }
  return result;
}

// ---------- row helpers ----------
type AgentRow = {
  id: string;
  workspace_id: string;
  owner_user_id: string;
  /** Fallback only: the name shown is always read from the account at view time. */
  owner_name: string;
  name: string;
  model: string;
  provider: string;
  persona: string;
  color: FamilyAgentColor;
  enabled: number;
  revision: number;
  created_at: string;
  updated_at: string;
};
type SnapshotEntry = {
  agentId: string;
  name: string;
  color: FamilyAgentColor;
  model: string;
  provider: string;
  providerUrl?: string;
  providerKind?: string;
  persona: string;
  ownerUserId: string;
  ownerName: string;
};
type Cause = { kind: string; by?: string; detail?: string };
type GroupRow = {
  id: string;
  workspace_id: string;
  kind: "dm" | "group";
  name: string;
  members: string;
  owners: string;
  snapshot: string;
  snapshot_hash: string;
  revision: number;
  status: FamilyGroupStatus;
  room_id: string | null;
  parent_group_id: string | null;
  created_by: string;
  client_request_id: string | null;
  approvals: string;
  causes: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  hash_salt: string | null;
};
type Group = Omit<
  GroupRow,
  "members" | "owners" | "snapshot" | "approvals" | "causes" | "hash_salt"
> & {
  members: string[];
  owners: string[];
  snapshot: SnapshotEntry[];
  approvals: Record<string, number>;
  causes: Cause[];
  hash_salt: string;
};
const OPEN: FamilyGroupStatus[] = ["proposed", "active", "paused"];

const newSalt = () => crypto.randomBytes(32).toString("hex");
/**
 * Server-salted commitment to the disclosure. Without the per-group secret
 * salt, a co-owner who knows every other field could confirm a guessed
 * (empty / template) persona offline; the salt is never returned.
 */
function hashSnapshot(
  groupId: string,
  revision: number,
  salt: string,
  snapshot: SnapshotEntry[],
) {
  return crypto
    .createHmac("sha256", salt)
    .update(JSON.stringify({ groupId, revision, snapshot }))
    .digest("hex");
}
// One-time backfill: groups written before the salt get one, and their hash
// is recomputed (same revision, approvals untouched; clients simply refetch).
{
  const legacy = db
    .prepare(
      "SELECT id,revision,snapshot FROM family_groups WHERE hash_salt IS NULL",
    )
    .all() as { id: string; revision: number; snapshot: string }[];
  if (legacy.length) {
    const update = db.prepare(
      "UPDATE family_groups SET hash_salt=?,snapshot_hash=? WHERE id=? AND hash_salt IS NULL",
    );
    db.transaction(() => {
      for (const r of legacy) {
        const salt = newSalt();
        update.run(
          salt,
          hashSnapshot(r.id, r.revision, salt, JSON.parse(r.snapshot)),
          r.id,
        );
      }
    })();
  }
}

const agentRow = (agentId: string) =>
  db.prepare("SELECT * FROM family_agents WHERE id=?").get(agentId) as
    AgentRow | undefined;
const groupFrom = (row: GroupRow): Group => ({
  ...row,
  members: JSON.parse(row.members),
  owners: JSON.parse(row.owners),
  snapshot: JSON.parse(row.snapshot),
  approvals: JSON.parse(row.approvals),
  causes: JSON.parse(row.causes),
  hash_salt: row.hash_salt || newSalt(), // persisted by saveGroup on next bump
});
const groupRow = (groupId: string) => {
  const row = db
    .prepare("SELECT * FROM family_groups WHERE id=?")
    .get(groupId) as GroupRow | undefined;
  return row ? groupFrom(row) : undefined;
};
function saveGroup(g: Group) {
  db.prepare(
    "UPDATE family_groups SET name=?,members=?,owners=?,snapshot=?,snapshot_hash=?,revision=?,status=?,room_id=?,approvals=?,causes=?,expires_at=?,updated_at=?,hash_salt=? WHERE id=?",
  ).run(
    g.name,
    JSON.stringify(g.members),
    JSON.stringify(g.owners),
    JSON.stringify(g.snapshot),
    g.snapshot_hash,
    g.revision,
    g.status,
    g.room_id,
    JSON.stringify(g.approvals),
    JSON.stringify(g.causes),
    g.expires_at,
    now(),
    g.hash_salt,
    g.id,
  );
}

// ---------- membership / roles ----------
const memberRole = (workspaceId: string, userId: string) =>
  (
    db
      .prepare(
        "SELECT role FROM memberships WHERE workspace_id=? AND user_id=?",
      )
      .get(workspaceId, userId) as { role: string } | undefined
  )?.role;
export function isWorkspaceMember(workspaceId: string, userId: string) {
  return !!memberRole(workspaceId, userId);
}
/**
 * Any current workspace member, viewers included. Used only for protective
 * "stop" actions (pause, archive, reject, block, disable own Agent, end a
 * friendship) so an owner demoted to viewer never loses the way to stop
 * their own Agent. Removed users fail here.
 */
function requireMember(actor: FamilyActor) {
  if (!memberRole(actor.workspaceId, actor.userId))
    fail(403, "forbidden", "你还没有加入这个工作空间。");
}
const isViewer = (actor: FamilyActor) =>
  actor.role === "viewer" ||
  memberRole(actor.workspaceId, actor.userId) === "viewer";
/** Create / approve / resume / expand / run: never viewers. Role is re-read from the DB. */
function requireWriter(actor: FamilyActor) {
  const role = memberRole(actor.workspaceId, actor.userId);
  if (!role) fail(403, "forbidden", "你还没有加入这个工作空间。");
  if (role === "viewer" || actor.role === "viewer")
    fail(403, "forbidden", "你目前只有查看权限。");
}
/** Owner-only: workspace admins/owners get no impersonation power. */
function ownedAgent(actor: FamilyActor, agentId: string) {
  const a = agentRow(agentId);
  if (!a || a.workspace_id !== actor.workspaceId) return notFound();
  if (a.owner_user_id !== actor.userId)
    fail(403, "forbidden", "只有伙伴的主人可以执行这个操作。");
  return a;
}
function visibleAgent(actor: FamilyActor, agentId: string) {
  const a = agentRow(agentId);
  if (!a || a.workspace_id !== actor.workspaceId) return notFound();
  if (!a.enabled && a.owner_user_id !== actor.userId) return unavailable();
  return a;
}

// ---------- owner identity: current name + stable member tag ----------
const TAG_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O/1/I
function randomTag() {
  let t = "";
  for (let i = 0; i < 4; i++)
    t += TAG_ALPHABET[crypto.randomInt(TAG_ALPHABET.length)];
  return t;
}
/** Random, stored, unique per workspace: not derived from the user id or email. */
function memberTag(workspaceId: string, userId: string) {
  const get = db.prepare(
    "SELECT tag FROM family_member_tags WHERE workspace_id=? AND user_id=?",
  );
  let row = get.get(workspaceId, userId) as { tag: string } | undefined;
  for (let i = 0; !row && i < 32; i++) {
    db.prepare(
      "INSERT OR IGNORE INTO family_member_tags VALUES(?,?,?,?)",
    ).run(workspaceId, userId, randomTag(), now());
    row = get.get(workspaceId, userId) as { tag: string } | undefined;
  }
  return row?.tag ?? "";
}
let userTableSeen = false;
/** Better Auth's `user` table (absent in store-only unit setups). */
function hasUserTable() {
  if (!userTableSeen)
    userTableSeen = !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'")
      .get();
  return userTableSeen;
}
const normalName = (n: string) =>
  n.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
type OwnerLookup = (userId: string, fallbackName: string) => FamilyOwnerIdentity;
/** Per-request resolver; caches names, tags and the duplicate-name index. */
function ownerDirectory(workspaceId: string): OwnerLookup {
  const cache = new Map<string, FamilyOwnerIdentity>();
  let byName: Map<string, Set<string>> | undefined;
  const index = () => {
    if (byName) return byName;
    byName = new Map();
    const rows = hasUserTable()
      ? (db
          .prepare(
            "SELECT id,name FROM user WHERE id IN (SELECT user_id FROM memberships WHERE workspace_id=? UNION SELECT owner_user_id FROM family_agents WHERE workspace_id=?)",
          )
          .all(workspaceId, workspaceId) as { id: string; name: string }[])
      : [];
    for (const r of rows) {
      const key = normalName(r.name || "");
      if (!byName.has(key)) byName.set(key, new Set());
      byName.get(key)!.add(r.id);
    }
    return byName;
  };
  return (userId, fallbackName) => {
    const hit = cache.get(userId);
    if (hit) return hit;
    const current = hasUserTable()
      ? (
          db.prepare("SELECT name FROM user WHERE id=?").get(userId) as
            { name: string } | undefined
        )?.name
      : undefined;
    const ownerName = (current ?? fallbackName ?? "").slice(0, 80);
    const same = index().get(normalName(ownerName));
    const info = {
      ownerName,
      ownerTag: memberTag(workspaceId, userId),
      ownerNameDuplicate: !!same && [...same].some((u) => u !== userId),
    };
    cache.set(userId, info);
    return info;
  };
}

const publicAgent = (
  a: AgentRow,
  dir: OwnerLookup = ownerDirectory(a.workspace_id),
): FamilyAgentPublicView => ({
  id: a.id,
  isMine: false,
  ...dir(a.owner_user_id, a.owner_name),
  name: a.name,
  color: a.color,
});
const ownerAgent = (
  a: AgentRow,
  dir: OwnerLookup = ownerDirectory(a.workspace_id),
): FamilyAgentOwnerView => ({
  id: a.id,
  isMine: true,
  workspaceId: a.workspace_id,
  ownerUserId: a.owner_user_id,
  ...dir(a.owner_user_id, a.owner_name),
  name: a.name,
  model: a.model,
  provider: a.provider,
  persona: a.persona,
  color: a.color,
  enabled: !!a.enabled,
  tools: false,
  revision: a.revision,
  createdAt: a.created_at,
  updatedAt: a.updated_at,
});
const agentView = (actor: FamilyActor, a: AgentRow, dir?: OwnerLookup) =>
  a.owner_user_id === actor.userId ? ownerAgent(a, dir) : publicAgent(a, dir);

// ---------- providers: frozen endpoint + offered model ----------
type ProviderRow = { kind: string; base_url: string; models: string };
const providerRow = (workspaceId: string, providerId: string) =>
  db
    .prepare(
      "SELECT kind,base_url,models FROM providers WHERE workspace_id=? AND id=?",
    )
    .get(workspaceId, providerId) as ProviderRow | undefined;
function modelOffered(workspaceId: string, providerId: string, model: string) {
  if (!model) return false;
  const p = providerRow(workspaceId, providerId);
  if (!p) return false;
  try {
    const models = JSON.parse(p.models);
    return Array.isArray(models) && models.includes(model);
  } catch {
    return false;
  }
}
/** Strict: a missing snapshot URL/kind or provider row never passes (P1-1). */
function endpointMatches(workspaceId: string, s: SnapshotEntry) {
  const p = providerRow(workspaceId, s.provider);
  return (
    !!p &&
    !!s.providerUrl &&
    !!s.providerKind &&
    p.base_url === s.providerUrl &&
    p.kind === s.providerKind
  );
}
const runnable = (workspaceId: string, s: SnapshotEntry) =>
  endpointMatches(workspaceId, s) &&
  modelOffered(workspaceId, s.provider, s.model);
/** Agents may be saved as drafts without a model; any chosen model must be offered. */
function assertAgentModel(workspaceId: string, provider: string, model: string) {
  if (model && !modelOffered(workspaceId, provider, model))
    fail(
      400,
      "invalid_input",
      "请选择工作空间中已配置的模型服务和该服务提供的模型。",
    );
}

// ---------- blocks / friendships / eligibility ----------
function blockedPair(x: AgentRow, y: AgentRow) {
  const q = db.prepare(
    "SELECT 1 FROM family_blocks WHERE removed_at IS NULL AND blocker_user_id=? AND (target_agent_id=? OR (scope='owner' AND target_user_id=?)) LIMIT 1",
  );
  if (q.get(x.owner_user_id, y.id, y.owner_user_id)) return x.owner_user_id;
  if (q.get(y.owner_user_id, x.id, x.owner_user_id)) return y.owner_user_id;
  return null;
}
const pairKey = (x: string, y: string) => (x < y ? [x, y] : [y, x]);
function friendshipStatus(x: string, y: string) {
  const [a, b] = pairKey(x, y);
  const row = db
    .prepare(
      "SELECT status FROM family_friendships WHERE agent_a=? AND agent_b=? AND status IN ('pending','accepted')",
    )
    .get(a, b) as { status: string } | undefined;
  return row?.status;
}
function eligibility(workspaceId: string, memberIds: string[]): Cause[] {
  const causes: Cause[] = [];
  const rows = memberIds.map((m) => agentRow(m));
  const owners = new Set<string>();
  for (const a of rows) {
    if (!a || a.workspace_id !== workspaceId) {
      causes.push({ kind: "agent_missing" });
      continue;
    }
    owners.add(a.owner_user_id);
    if (!a.enabled)
      causes.push({ kind: "agent_disabled", by: a.owner_user_id });
  }
  for (const owner of owners) {
    const role = memberRole(workspaceId, owner);
    if (!role) causes.push({ kind: "owner_left" });
    // Demotion pauses like removal: no co-owner keeps running against an
    // owner who can no longer approve or resume.
    else if (role === "viewer")
      causes.push({ kind: "owner_readonly", by: owner });
  }
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const x = rows[i],
        y = rows[j];
      if (!x || !y || x.owner_user_id === y.owner_user_id) continue;
      const blocker = blockedPair(x, y);
      if (blocker) causes.push({ kind: "blocked", by: blocker });
      if (friendshipStatus(x.id, y.id) !== "accepted")
        causes.push({ kind: "not_friends" });
    }
  return causes;
}
/** Eligibility plus the frozen endpoint of every member. */
function groupProblems(g: Group): Cause[] {
  const causes = eligibility(g.workspace_id, g.members);
  if (g.snapshot.some((s) => !endpointMatches(g.workspace_id, s)))
    causes.push({ kind: "provider_changed" });
  return causes;
}
function mergeCauses(base: Cause[], extra: Cause[]) {
  const out = [...base];
  for (const c of extra)
    if (!out.some((o) => o.kind === c.kind && o.by === c.by))
      out.push({ kind: c.kind, by: c.by });
  return out;
}

// ---------- snapshot ----------
function buildSnapshot(memberIds: string[]): SnapshotEntry[] {
  const used = new Set<string>();
  return memberIds.map((m) => {
    const a = agentRow(m)!;
    const provider = providerRow(a.workspace_id, a.provider);
    let name = a.name;
    for (let n = 2; used.has(name); n++)
      name = `${a.name.slice(0, FAMILY_LIMITS.nameMax - String(n).length)}${n}`;
    used.add(name);
    return {
      agentId: a.id,
      name,
      color: a.color,
      model: a.model,
      provider: a.provider,
      providerUrl: provider?.base_url,
      providerKind: provider?.kind,
      persona: a.persona,
      ownerUserId: a.owner_user_id,
      ownerName: a.owner_name,
    };
  });
}
function bump(g: Group) {
  g.revision += 1;
  g.approvals = {};
  g.snapshot_hash = hashSnapshot(g.id, g.revision, g.hash_salt, g.snapshot);
}
/**
 * Legacy migration: snapshots written before endpoints were mandatory may lack
 * providerUrl/providerKind. If the provider now exists, disclose its current
 * endpoint in the snapshot; the caller must then require fresh approval.
 */
function fillLegacyEndpoints(g: Group) {
  let changed = false;
  g.snapshot = g.snapshot.map((s) => {
    if (s.providerUrl && s.providerKind) return s;
    const p = providerRow(g.workspace_id, s.provider);
    if (!p) return s;
    changed = true;
    return { ...s, providerUrl: p.base_url, providerKind: p.kind };
  });
  return changed;
}

/**
 * Re-evaluates eligibility. Expires/cancels proposals and pauses active rooms
 * whose owners, roles, agents, friendships, blocks or frozen endpoints no
 * longer allow supervision. Must be called inside tx().
 */
function reconcile(g: Group): Group {
  if (!OPEN.includes(g.status)) return g;
  if (g.status === "proposed" && g.expires_at && g.expires_at <= now()) {
    g.status = "expired";
    bump(g);
    saveGroup(g);
    audit(g.workspace_id, "system", "family.group.expire", g.id);
    return g;
  }
  if (fillLegacyEndpoints(g)) {
    // Nobody approved this endpoint: stop and require fresh unanimous approval.
    if (g.status === "active") {
      g.status = "paused";
      if (g.room_id) pendingCancels.push(g.room_id);
    }
    if (g.status === "paused")
      g.causes = mergeCauses(g.causes, [{ kind: "reapproval" }]);
    bump(g);
    saveGroup(g);
    audit(g.workspace_id, "system", "family.group.reapproval", g.id);
  }
  const problems = groupProblems(g);
  if (!problems.length) return g;
  if (g.status === "proposed") {
    g.status = "cancelled";
    g.causes = mergeCauses(g.causes, problems);
    bump(g);
    saveGroup(g);
    audit(g.workspace_id, "system", "family.group.cancel", g.id);
  } else if (g.status === "active") {
    g.status = "paused";
    g.causes = mergeCauses(g.causes, problems);
    bump(g);
    saveGroup(g);
    if (g.room_id) pendingCancels.push(g.room_id);
    audit(g.workspace_id, "system", "family.group.pause", g.id);
  } else {
    const merged = mergeCauses(g.causes, problems);
    const hadApprovals = Object.keys(g.approvals).length > 0;
    if (merged.length !== g.causes.length || hadApprovals) {
      g.causes = merged;
      if (hadApprovals) bump(g);
      saveGroup(g);
    }
  }
  return g;
}
function reconcileGroupsWithAgents(agentIds: string[]) {
  if (!agentIds.length) return;
  const rows = db
    .prepare(
      "SELECT * FROM family_groups WHERE status IN ('proposed','active','paused')",
    )
    .all() as GroupRow[];
  const set = new Set(agentIds);
  for (const row of rows) {
    const g = groupFrom(row);
    if (g.members.some((m) => set.has(m))) reconcile(g);
  }
}

// ---------- agents ----------
export function listAgents(actor: FamilyActor) {
  const rows = db
    .prepare(
      "SELECT * FROM family_agents WHERE workspace_id=? ORDER BY created_at, id",
    )
    .all(actor.workspaceId) as AgentRow[];
  const dir = ownerDirectory(actor.workspaceId);
  return rows
    .filter((a) => a.owner_user_id === actor.userId || a.enabled)
    .map((a) => agentView(actor, a, dir));
}
export function createAgent(actor: FamilyActor, input: FamilyAgentCreate) {
  requireWriter(actor);
  return tx(() => {
    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM family_agents WHERE workspace_id=? AND owner_user_id=?",
        )
        .get(actor.workspaceId, actor.userId) as { n: number }
    ).n;
    if (count >= FAMILY_LIMITS.agentsPerOwner)
      fail(409, "limit", "伙伴数量已达上限。");
    assertAgentModel(actor.workspaceId, input.provider, input.model);
    const agentId = id(),
      date = now();
    db.prepare(
      "INSERT INTO family_agents(id,workspace_id,owner_user_id,owner_name,name,model,provider,persona,color,enabled,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,?,?)",
    ).run(
      agentId,
      actor.workspaceId,
      actor.userId,
      actor.userName.slice(0, 80),
      input.name,
      input.model,
      input.provider,
      input.persona,
      input.color,
      date,
      date,
    );
    audit(actor.workspaceId, actor.userId, "family.agent.create", agentId);
    return ownerAgent(agentRow(agentId)!);
  });
}
export function updateAgent(
  actor: FamilyActor,
  agentId: string,
  input: FamilyAgentUpdate,
) {
  requireMember(actor);
  return tx(() => {
    const a = ownedAgent(actor, agentId);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== a.revision
    )
      fail(409, "stale_revision", "伙伴已被修改，请刷新后重试。");
    const next = {
      name: input.name ?? a.name,
      model: input.model ?? a.model,
      provider: input.provider ?? a.provider,
      persona: input.persona ?? a.persona,
      color: input.color ?? a.color,
      enabled: input.enabled === undefined ? !!a.enabled : input.enabled,
    };
    const configChanged =
      next.name !== a.name ||
      next.model !== a.model ||
      next.provider !== a.provider ||
      next.persona !== a.persona ||
      next.color !== a.color;
    const enabledChanged = next.enabled !== !!a.enabled;
    if (!configChanged && !enabledChanged) return ownerAgent(a);
    // Disabling is a stop right every owner keeps, even as a viewer;
    // re-enabling or reconfiguring needs write access.
    if (configChanged || next.enabled) requireWriter(actor);
    if (next.provider !== a.provider || next.model !== a.model)
      assertAgentModel(actor.workspaceId, next.provider, next.model);
    db.prepare(
      "UPDATE family_agents SET name=?,model=?,provider=?,persona=?,color=?,enabled=?,owner_name=?,revision=revision+1,updated_at=? WHERE id=?",
    ).run(
      next.name,
      next.model,
      next.provider,
      next.persona,
      next.color,
      next.enabled ? 1 : 0,
      actor.userName.slice(0, 80),
      now(),
      a.id,
    );
    if (enabledChanged && !next.enabled) {
      db.prepare(
        "UPDATE family_friendships SET status='cancelled',updated_at=? WHERE status='pending' AND (agent_a=? OR agent_b=?)",
      ).run(now(), a.id, a.id);
      reconcileGroupsWithAgents([a.id]);
      audit(actor.workspaceId, actor.userId, "family.agent.disable", a.id);
    } else if (enabledChanged) {
      audit(actor.workspaceId, actor.userId, "family.agent.enable", a.id);
    }
    if (configChanged) {
      // Pending proposals must disclose the new configuration: new revision,
      // approvals invalidated. Active/paused rooms keep their frozen copy.
      const rows = db
        .prepare("SELECT * FROM family_groups WHERE status='proposed'")
        .all() as GroupRow[];
      for (const row of rows) {
        const g = groupFrom(row);
        if (!g.members.includes(a.id)) continue;
        g.snapshot = buildSnapshot(g.members);
        bump(g);
        saveGroup(g);
      }
      audit(actor.workspaceId, actor.userId, "family.agent.update", a.id);
    }
    return ownerAgent(agentRow(a.id)!);
  });
}

// ---------- friendships ----------
type FriendRow = {
  id: string;
  workspace_id: string;
  agent_a: string;
  agent_b: string;
  requester_agent_id: string;
  status: FamilyFriendshipView["status"];
  created_at: string;
  updated_at: string;
};
function friendshipView(
  actor: FamilyActor,
  f: FriendRow,
  dir: OwnerLookup = ownerDirectory(actor.workspaceId),
  viewer = isViewer(actor),
): FamilyFriendshipView {
  const a = agentRow(f.agent_a)!,
    b = agentRow(f.agent_b)!;
  const target = f.requester_agent_id === a.id ? b : a;
  return {
    id: f.id,
    status: f.status,
    requesterAgentId: f.requester_agent_id,
    agents: [agentView(actor, a, dir), agentView(actor, b, dir)],
    canAccept:
      !viewer &&
      f.status === "pending" &&
      target.owner_user_id === actor.userId,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  };
}
export function listFriendships(actor: FamilyActor) {
  const rows = db
    .prepare(
      `SELECT f.* FROM family_friendships f JOIN family_agents a ON a.id=f.agent_a JOIN family_agents b ON b.id=f.agent_b
       WHERE f.workspace_id=? AND (a.owner_user_id=? OR b.owner_user_id=?) ORDER BY f.updated_at DESC LIMIT 500`,
    )
    .all(actor.workspaceId, actor.userId, actor.userId) as FriendRow[];
  const dir = ownerDirectory(actor.workspaceId);
  const viewer = isViewer(actor);
  return rows.map((f) => friendshipView(actor, f, dir, viewer));
}
export function requestFriendship(
  actor: FamilyActor,
  fromAgentId: string,
  toAgentId: string,
) {
  requireWriter(actor);
  return tx(() => {
    const from = ownedAgent(actor, fromAgentId);
    const to = visibleAgent(actor, toAgentId);
    if (from.id === to.id) fail(400, "invalid_input", "不能和自己成为好友。");
    if (!from.enabled || !to.enabled || blockedPair(from, to)) unavailable();
    const [a, b] = pairKey(from.id, to.id);
    const existing = db
      .prepare(
        "SELECT * FROM family_friendships WHERE agent_a=? AND agent_b=? AND status IN ('pending','accepted')",
      )
      .get(a, b) as FriendRow | undefined;
    if (existing) return friendshipView(actor, existing); // idempotent replay
    const pending = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM family_friendships f JOIN family_agents r ON r.id=f.requester_agent_id WHERE f.status='pending' AND r.owner_user_id=?",
        )
        .get(actor.userId) as { n: number }
    ).n;
    if (pending >= FAMILY_LIMITS.pendingFriendRequestsPerOwner)
      fail(409, "limit", "待处理的好友请求过多。");
    const fid = id(),
      date = now();
    db.prepare("INSERT INTO family_friendships VALUES(?,?,?,?,?,?,?,?)").run(
      fid,
      actor.workspaceId,
      a,
      b,
      from.id,
      "pending",
      date,
      date,
    );
    audit(actor.workspaceId, actor.userId, "family.friend.request", fid);
    return friendshipView(
      actor,
      db
        .prepare("SELECT * FROM family_friendships WHERE id=?")
        .get(fid) as FriendRow,
    );
  });
}
export function friendshipAction(
  actor: FamilyActor,
  friendshipId: string,
  action: "accept" | "reject" | "cancel" | "remove",
) {
  // reject / cancel / remove only ever reduce exposure: viewers keep them.
  if (action === "accept") requireWriter(actor);
  else requireMember(actor);
  const result = tx((): FamilyFriendshipView | null => {
    const f = db
      .prepare("SELECT * FROM family_friendships WHERE id=?")
      .get(friendshipId) as FriendRow | undefined;
    if (!f || f.workspace_id !== actor.workspaceId) return notFound();
    const a = agentRow(f.agent_a)!,
      b = agentRow(f.agent_b)!;
    const requester = f.requester_agent_id === a.id ? a : b;
    const target = requester === a ? b : a;
    if (a.owner_user_id !== actor.userId && b.owner_user_id !== actor.userId)
      return notFound();
    const set = (status: FriendRow["status"]) => {
      db.prepare(
        "UPDATE family_friendships SET status=?,updated_at=? WHERE id=?",
      ).run(status, now(), f.id);
      audit(actor.workspaceId, actor.userId, `family.friend.${action}`, f.id);
    };
    const done = () =>
      friendshipView(
        actor,
        db
          .prepare("SELECT * FROM family_friendships WHERE id=?")
          .get(f.id) as FriendRow,
      );
    if (action === "accept" || action === "reject") {
      // Each owner approves only their own side; same owner may approve both.
      if (target.owner_user_id !== actor.userId)
        fail(403, "forbidden", "只有被邀请伙伴的主人可以处理这个请求。");
      if (f.status === (action === "accept" ? "accepted" : "rejected"))
        return done();
      if (f.status !== "pending")
        fail(409, "conflict", "这个请求已经处理过了。");
      if (
        action === "accept" &&
        (!a.enabled || !b.enabled || blockedPair(a, b))
      ) {
        set("cancelled");
        return null; // committed, then reported as generic unavailable
      }
      set(action === "accept" ? "accepted" : "rejected");
      return done();
    }
    if (action === "cancel") {
      if (requester.owner_user_id !== actor.userId)
        fail(403, "forbidden", "只有发起方的主人可以撤回请求。");
      if (f.status === "cancelled") return done();
      if (f.status !== "pending")
        fail(409, "conflict", "这个请求已经处理过了。");
      set("cancelled");
      return done();
    }
    if (f.status === "removed") return done();
    if (f.status !== "accepted") fail(409, "conflict", "你们还不是好友。");
    set("removed");
    reconcileGroupsWithAgents([a.id, b.id]);
    return done();
  });
  return result ?? unavailable();
}

// ---------- groups ----------
type ViewContext = { dir: OwnerLookup; viewer: boolean };
const viewContext = (actor: FamilyActor): ViewContext => ({
  dir: ownerDirectory(actor.workspaceId),
  viewer: isViewer(actor),
});
const MY_REASON: Record<string, string> = {
  blocked: "你屏蔽了其中的成员",
  agent_disabled: "你停用了其中的伙伴",
  owner_readonly:
    "你目前只有查看权限：仍可暂停、归档或拒绝，但不能批准或恢复",
};
const SHARED_REASON: Record<string, string> = {
  provider_changed:
    "成员使用的模型服务地址或协议已变化，恢复原设置前无法继续",
  reapproval: "需要所有主人重新确认模型服务地址后才能继续",
};
function groupView(
  actor: FamilyActor,
  g: Group,
  ctx: ViewContext = viewContext(actor),
): FamilyGroupView {
  const fallbackNames = new Map<string, string>();
  for (const s of g.snapshot)
    if (!fallbackNames.has(s.ownerUserId))
      fallbackNames.set(s.ownerUserId, s.ownerName);
  const members: FamilySnapshotMember[] = g.snapshot.map((s) => ({
    agentId: s.agentId,
    name: s.name,
    color: s.color,
    model: s.model,
    provider: s.provider,
    providerUrl: s.providerUrl,
    providerKind: s.providerKind,
    ...ctx.dir(s.ownerUserId, s.ownerName),
    isMine: s.ownerUserId === actor.userId,
  }));
  const myReasons = g.causes
    .filter((c) => c.by === actor.userId)
    .map((c) =>
      c.kind === "owner_pause"
        ? `你暂停了这个群${c.detail ? `：${c.detail}` : ""}`
        : MY_REASON[c.kind] || "你的操作使其暂停",
    );
  const sharedReasons =
    g.status === "active"
      ? []
      : [
          ...new Set(
            g.causes
              .filter((c) => !c.by && SHARED_REASON[c.kind])
              .map((c) => SHARED_REASON[c.kind]),
          ),
        ];
  const needsApproval = g.status === "proposed" || g.status === "paused";
  const mineMissing = g.approvals[actor.userId] !== g.revision;
  const writer = !ctx.viewer;
  return {
    id: g.id,
    kind: g.kind,
    name: g.name,
    status: g.status,
    revision: g.revision,
    snapshotHash: g.snapshot_hash,
    members,
    owners: g.owners.map((o) => {
      const who = ctx.dir(o, fallbackNames.get(o) || "");
      return {
        name: who.ownerName,
        tag: who.ownerTag,
        nameDuplicate: who.ownerNameDuplicate,
        isMe: o === actor.userId,
        approvedCurrentRevision:
          g.status === "active" || g.approvals[o] === g.revision,
      };
    }),
    myApprovalNeeded: needsApproval && mineMissing,
    can: {
      approve: writer && g.status === "proposed" && mineMissing,
      reject: g.status === "proposed",
      pause:
        g.status === "active" ||
        (g.status === "paused" &&
          !g.causes.some(
            (c) => c.kind === "owner_pause" && c.by === actor.userId,
          )),
      resume: writer && g.status === "paused" && mineMissing,
      archive: g.status === "active" || g.status === "paused",
      expand:
        writer && ["active", "paused", "archived"].includes(g.status),
    },
    roomId: g.room_id,
    parentGroupId: g.parent_group_id,
    expiresAt: g.status === "proposed" ? g.expires_at : null,
    canRun: g.status === "active",
    availability: {
      unavailable: g.status !== "active",
      myReasons,
      sharedReasons,
    },
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}
/**
 * Commits eligibility reconciliation (pause/cancel/expire) in its own
 * transaction so a later rejected mutation cannot roll it back.
 */
function preflight(groupId: string) {
  const g = groupRow(groupId);
  if (g) tx(() => reconcile(g));
}
/** Group access: actor must be one of the deduplicated owners and a current member. */
function accessGroup(actor: FamilyActor, groupId: string) {
  const g = groupRow(groupId);
  if (
    !g ||
    g.workspace_id !== actor.workspaceId ||
    !g.owners.includes(actor.userId)
  )
    return notFound();
  if (!isWorkspaceMember(g.workspace_id, actor.userId)) return notFound();
  return reconcile(g);
}
export function listGroups(actor: FamilyActor) {
  return tx(() => {
    const rows = db
      .prepare(
        "SELECT g.* FROM family_groups g, json_each(g.owners) o WHERE g.workspace_id=? AND o.value=? ORDER BY g.updated_at DESC LIMIT 200",
      )
      .all(actor.workspaceId, actor.userId) as GroupRow[];
    const ctx = viewContext(actor);
    return rows.map((r) => groupView(actor, reconcile(groupFrom(r)), ctx));
  });
}
export function getGroup(actor: FamilyActor, groupId: string) {
  preflight(groupId);
  return tx(() => groupView(actor, accessGroup(actor, groupId)));
}
/** Active + paused groups the user co-owns (archived/terminal ones are free). */
function liveGroupCount(workspaceId: string, userId: string) {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM family_groups g, json_each(g.owners) o WHERE g.workspace_id=? AND o.value=? AND g.status IN ('active','paused')",
      )
      .get(workspaceId, userId) as { n: number }
  ).n;
}
const LIVE_LIMIT_MESSAGE = `你进行中的监督群已达上限（${FAMILY_LIMITS.activeGroupsPerOwner} 个），请先归档不再使用的群。`;
function proposeInternal(
  actor: FamilyActor,
  input: {
    kind: "dm" | "group";
    name: string;
    agentIds: string[];
    clientRequestId?: string;
  },
  parentGroupId: string | null,
) {
  if (input.clientRequestId) {
    const existing = db
      .prepare(
        "SELECT * FROM family_groups WHERE workspace_id=? AND created_by=? AND client_request_id=?",
      )
      .get(actor.workspaceId, actor.userId, input.clientRequestId) as
      GroupRow | undefined;
    if (existing) {
      const g = groupFrom(existing);
      const same =
        g.parent_group_id === parentGroupId &&
        g.members.length === input.agentIds.length &&
        g.members.every((m, i) => m === input.agentIds[i]);
      if (!same) fail(409, "conflict", "这个请求编号已用于其他提案。");
      return groupView(actor, reconcile(g)); // secure replay: scoped to actor
    }
  }
  if (new Set(input.agentIds).size !== input.agentIds.length)
    fail(400, "invalid_input", "成员不能重复。");
  if (input.kind === "dm" && input.agentIds.length !== 2)
    fail(400, "invalid_input", "私聊需要恰好两位伙伴。");
  if (
    input.agentIds.length < FAMILY_LIMITS.groupMinAgents ||
    input.agentIds.length > FAMILY_LIMITS.groupMaxAgents
  )
    fail(400, "invalid_input", "群聊需要 2-5 位伙伴。");
  const rows = input.agentIds.map((m) => visibleAgent(actor, m));
  if (!rows.some((r) => r.owner_user_id === actor.userId))
    fail(403, "forbidden", "提案中至少需要一位你自己的伙伴。");
  if (eligibility(actor.workspaceId, input.agentIds).length) unavailable();
  const open = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM family_groups WHERE created_by=? AND status='proposed'",
      )
      .get(actor.userId) as { n: number }
  ).n;
  if (open >= FAMILY_LIMITS.openProposalsPerOwner)
    fail(409, "limit", "待处理的提案过多。");
  if (
    liveGroupCount(actor.workspaceId, actor.userId) >=
    FAMILY_LIMITS.activeGroupsPerOwner
  )
    fail(409, "limit", LIVE_LIMIT_MESSAGE);
  const owners = [...new Set(rows.map((r) => r.owner_user_id))];
  const snapshot = buildSnapshot(input.agentIds);
  // P1-1: every member must freeze an existing provider, its exact endpoint
  // and protocol, and a model that provider offers. Nothing is proposed that
  // could later be bound to an endpoint no owner saw.
  for (const s of snapshot) {
    if (runnable(actor.workspaceId, s)) continue;
    if (s.ownerUserId === actor.userId)
      fail(
        400,
        "invalid_input",
        `请先为「${s.name}」选择工作空间中可用的模型服务和模型。`,
      );
    unavailable(); // another owner's private config: generic
  }
  const gid = id(),
    date = now(),
    salt = newSalt();
  const expires = new Date(
    Date.now() + FAMILY_LIMITS.proposalTtlMs,
  ).toISOString();
  db.prepare(
    "INSERT INTO family_groups(id,workspace_id,kind,name,members,owners,snapshot,snapshot_hash,revision,status,room_id,parent_group_id,created_by,client_request_id,approvals,causes,expires_at,created_at,updated_at,hash_salt) VALUES(?,?,?,?,?,?,?,?,1,'proposed',NULL,?,?,?,'{}','[]',?,?,?,?)",
  ).run(
    gid,
    actor.workspaceId,
    input.kind,
    input.name,
    JSON.stringify(input.agentIds),
    JSON.stringify(owners),
    JSON.stringify(snapshot),
    hashSnapshot(gid, 1, salt, snapshot),
    parentGroupId,
    actor.userId,
    input.clientRequestId ?? null,
    expires,
    date,
    date,
    salt,
  );
  audit(
    actor.workspaceId,
    actor.userId,
    parentGroupId ? "family.group.expand" : "family.group.propose",
    gid,
  );
  return groupView(actor, groupRow(gid)!);
}
export function createGroup(actor: FamilyActor, input: FamilyGroupCreate) {
  requireWriter(actor);
  return tx(() => proposeInternal(actor, input, null));
}
function checkRevision(
  g: Group,
  body: { revision: number; snapshotHash?: string },
) {
  if (
    body.revision !== g.revision ||
    (body.snapshotHash && body.snapshotHash !== g.snapshot_hash)
  )
    fail(409, "stale_revision", "内容已经变化，请查看最新版本后再确认。");
}
function activate(g: Group) {
  const agents: Agent[] = g.snapshot.map((s) => ({
    id: s.agentId, // global family agent id == local room agent id
    name: s.name,
    model: s.model,
    provider: s.provider,
    persona: s.persona,
    color: s.color,
    enabled: true,
    tools: false,
  }));
  const room = createRoom(
    g.workspace_id,
    g.created_by,
    g.name.slice(0, 40),
    agents,
    "private",
  );
  db.prepare("UPDATE rooms SET project_mode='off' WHERE id=?").run(room.id);
  g.room_id = room.id;
}
export function approveGroup(
  actor: FamilyActor,
  groupId: string,
  body: { revision: number; snapshotHash?: string },
) {
  requireWriter(actor);
  preflight(groupId);
  return tx(() => {
    const g = accessGroup(actor, groupId);
    if (g.status === "expired") fail(409, "expired", "提案已过期。");
    if (
      g.status === "active" &&
      g.approvals[actor.userId] === undefined &&
      body.revision === g.revision - 1
    )
      return groupView(actor, g); // replay of the approval that activated it
    if (g.status !== "proposed") return unavailable();
    checkRevision(g, body);
    if (g.approvals[actor.userId] === g.revision) return groupView(actor, g);
    g.approvals[actor.userId] = g.revision;
    audit(actor.workspaceId, actor.userId, "family.group.approve", g.id);
    if (g.owners.every((o) => g.approvals[o] === g.revision)) {
      // Same transaction as room creation: eligibility, frozen endpoints and
      // offered models, then every owner's active+paused cap.
      if (
        groupProblems(g).length ||
        !g.snapshot.every((s) => runnable(g.workspace_id, s))
      )
        return unavailable();
      if (
        liveGroupCount(g.workspace_id, actor.userId) >=
        FAMILY_LIMITS.activeGroupsPerOwner
      )
        fail(409, "limit", LIVE_LIMIT_MESSAGE);
      if (
        g.owners.some(
          (o) =>
            liveGroupCount(g.workspace_id, o) >=
            FAMILY_LIMITS.activeGroupsPerOwner,
        )
      )
        return unavailable(); // another owner's count stays private
      activate(g);
      g.status = "active";
      g.expires_at = null;
      bump(g);
      audit(actor.workspaceId, actor.userId, "family.group.activate", g.id);
    }
    saveGroup(g);
    return groupView(actor, g);
  });
}
/** Stop right: viewers keep it. */
export function rejectGroup(
  actor: FamilyActor,
  groupId: string,
  body: { revision: number },
) {
  requireMember(actor);
  preflight(groupId);
  return tx(() => {
    const g = accessGroup(actor, groupId);
    if (g.status === "rejected") return groupView(actor, g);
    if (g.status !== "proposed") return unavailable();
    checkRevision(g, body);
    g.status = "rejected";
    bump(g);
    saveGroup(g);
    audit(actor.workspaceId, actor.userId, "family.group.reject", g.id);
    return groupView(actor, g);
  });
}
/** Stop right: viewers keep it. */
export function pauseGroup(
  actor: FamilyActor,
  groupId: string,
  reason?: string,
) {
  requireMember(actor);
  preflight(groupId);
  return tx(() => {
    const g = accessGroup(actor, groupId);
    if (g.status !== "active" && g.status !== "paused") return unavailable();
    const already = g.causes.some(
      (c) => c.kind === "owner_pause" && c.by === actor.userId,
    );
    if (g.status === "paused" && already) return groupView(actor, g);
    g.causes = [
      ...g.causes,
      { kind: "owner_pause", by: actor.userId, detail: reason?.slice(0, 200) },
    ];
    if (g.status === "active" && g.room_id) pendingCancels.push(g.room_id);
    g.status = "paused";
    bump(g);
    saveGroup(g);
    audit(actor.workspaceId, actor.userId, "family.group.pause", g.id);
    return groupView(actor, g);
  });
}
export function resumeGroup(
  actor: FamilyActor,
  groupId: string,
  body: { revision: number; snapshotHash?: string },
) {
  requireWriter(actor);
  preflight(groupId);
  return tx(() => {
    const g = accessGroup(actor, groupId);
    if (g.status === "active" && body.revision === g.revision - 1)
      return groupView(actor, g);
    if (g.status !== "paused") return unavailable();
    checkRevision(g, body);
    // Block / disabled / non-member / read-only / unfriended / endpoint
    // causes must be fixed first.
    if (groupProblems(g).length) return unavailable();
    const room = g.room_id ? getRoom(g.room_id) : undefined;
    if (!room || room.archived) return unavailable();
    if (g.approvals[actor.userId] === g.revision) return groupView(actor, g);
    g.approvals[actor.userId] = g.revision;
    audit(actor.workspaceId, actor.userId, "family.group.resume_approve", g.id);
    if (g.owners.every((o) => g.approvals[o] === g.revision)) {
      g.status = "active";
      g.causes = [];
      bump(g);
      audit(actor.workspaceId, actor.userId, "family.group.resume", g.id);
    }
    saveGroup(g);
    return groupView(actor, g);
  });
}
export function expandGroup(
  actor: FamilyActor,
  groupId: string,
  input: FamilyExpand,
) {
  requireWriter(actor);
  preflight(groupId);
  return tx(() => {
    const parent = accessGroup(actor, groupId);
    if (!["active", "paused", "archived"].includes(parent.status))
      return unavailable();
    const added = input.addAgentIds.filter((a) => !parent.members.includes(a));
    if (added.length !== input.addAgentIds.length)
      fail(400, "invalid_input", "新增成员已在群里。");
    // Always a separate proposal and, on activation, a brand-new AF room.
    // The original group is never mutated and no history/tasks are copied.
    return proposeInternal(
      actor,
      {
        kind: "group",
        name: input.name ?? parent.name,
        agentIds: [...parent.members, ...added],
        clientRequestId: input.clientRequestId,
      },
      parent.id,
    );
  });
}
/** Stop right: viewers keep it. */
export function archiveGroup(actor: FamilyActor, groupId: string) {
  requireMember(actor);
  preflight(groupId);
  return tx(() => {
    const g = accessGroup(actor, groupId);
    if (g.status === "archived") return groupView(actor, g);
    if (g.status !== "active" && g.status !== "paused") return unavailable();
    if (g.status === "active" && g.room_id) pendingCancels.push(g.room_id);
    g.status = "archived";
    bump(g);
    saveGroup(g);
    if (g.room_id)
      db.prepare("UPDATE rooms SET archived=1,updated_at=? WHERE id=?").run(
        now(),
        g.room_id,
      );
    audit(actor.workspaceId, actor.userId, "family.group.archive", g.id);
    return groupView(actor, g);
  });
}

// ---------- blocks ----------
type BlockRow = {
  id: string;
  workspace_id: string;
  blocker_user_id: string;
  scope: "agent" | "owner";
  target_agent_id: string;
  target_user_id: string;
  note: string;
  created_at: string;
  removed_at: string | null;
};
const blockView = (
  b: BlockRow,
  dir: OwnerLookup = ownerDirectory(b.workspace_id),
): FamilyBlockView => {
  const a = agentRow(b.target_agent_id);
  const owner = dir(b.target_user_id, a?.owner_name ?? "");
  return {
    id: b.id,
    scope: b.scope,
    targetAgentId: b.target_agent_id,
    targetName: b.scope === "owner" ? owner.ownerName : (a?.name ?? ""),
    targetOwnerTag: owner.ownerTag,
    note: b.note,
    createdAt: b.created_at,
  };
};
/** Only the blocker ever sees their blocks (and private note). */
export function listBlocks(actor: FamilyActor) {
  const dir = ownerDirectory(actor.workspaceId);
  return (
    db
      .prepare(
        "SELECT * FROM family_blocks WHERE workspace_id=? AND blocker_user_id=? AND removed_at IS NULL ORDER BY created_at DESC",
      )
      .all(actor.workspaceId, actor.userId) as BlockRow[]
  ).map((b) => blockView(b, dir));
}
/** Stop right: viewers keep it. */
export function createBlock(actor: FamilyActor, input: FamilyBlockCreate) {
  requireMember(actor);
  return tx(() => {
    const target = agentRow(input.agentId);
    if (!target || target.workspace_id !== actor.workspaceId) return notFound();
    if (target.owner_user_id === actor.userId)
      fail(400, "invalid_input", "不能屏蔽自己的伙伴。");
    const existing = db
      .prepare(
        "SELECT * FROM family_blocks WHERE blocker_user_id=? AND workspace_id=? AND scope=? AND removed_at IS NULL AND (target_agent_id=? OR (scope='owner' AND target_user_id=?))",
      )
      .get(
        actor.userId,
        actor.workspaceId,
        input.scope,
        target.id,
        target.owner_user_id,
      ) as BlockRow | undefined;
    if (existing) return blockView(existing);
    const bid = id();
    db.prepare("INSERT INTO family_blocks VALUES(?,?,?,?,?,?,?,?,NULL)").run(
      bid,
      actor.workspaceId,
      actor.userId,
      input.scope,
      target.id,
      target.owner_user_id,
      input.note,
      now(),
    );
    const mine = (
      db
        .prepare(
          "SELECT id FROM family_agents WHERE workspace_id=? AND owner_user_id=?",
        )
        .all(actor.workspaceId, actor.userId) as { id: string }[]
    ).map((r) => r.id);
    const targets =
      input.scope === "agent"
        ? [target.id]
        : (
            db
              .prepare(
                "SELECT id FROM family_agents WHERE workspace_id=? AND owner_user_id=?",
              )
              .all(actor.workspaceId, target.owner_user_id) as { id: string }[]
          ).map((r) => r.id);
    const date = now();
    for (const x of mine)
      for (const y of targets) {
        const [a, b] = pairKey(x, y);
        db.prepare(
          "UPDATE family_friendships SET status=CASE status WHEN 'pending' THEN 'cancelled' ELSE 'removed' END,updated_at=? WHERE agent_a=? AND agent_b=? AND status IN ('pending','accepted')",
        ).run(date, a, b);
      }
    // Shared rooms pause, pending proposals cancel; unblocking revives nothing.
    reconcileGroupsWithAgents(
      [...mine, ...targets].filter((v, i, arr) => arr.indexOf(v) === i),
    );
    audit(actor.workspaceId, actor.userId, "family.block.create", bid);
    return blockView(
      db.prepare("SELECT * FROM family_blocks WHERE id=?").get(bid) as BlockRow,
    );
  });
}
/** Unblocking widens exposure (even though it revives nothing): writers only. */
export function removeBlock(actor: FamilyActor, blockId: string) {
  requireWriter(actor);
  return tx(() => {
    const b = db
      .prepare("SELECT * FROM family_blocks WHERE id=?")
      .get(blockId) as BlockRow | undefined;
    if (
      !b ||
      b.workspace_id !== actor.workspaceId ||
      b.blocker_user_id !== actor.userId
    )
      return notFound();
    if (!b.removed_at) {
      db.prepare("UPDATE family_blocks SET removed_at=? WHERE id=?").run(
        now(),
        b.id,
      );
      audit(actor.workspaceId, actor.userId, "family.block.remove", b.id);
    }
    return true;
  });
}

// ---------- integration helpers for app.ts / orchestrator (Codex) ----------
function groupForRoom(roomId: string) {
  const row = db
    .prepare("SELECT * FROM family_groups WHERE room_id=?")
    .get(roomId) as GroupRow | undefined;
  return row ? groupFrom(row) : undefined;
}
/**
 * null => not a supervised family room (use ordinary room rules).
 * boolean => authoritative read access (owners who are still workspace
 * members, viewers included: a demoted owner keeps reading and stopping).
 */
export function familyRoomAccess(
  roomId: string,
  userId: string,
): boolean | null {
  const found = groupForRoom(roomId);
  if (!found) return null;
  return tx(() => {
    const g = reconcile(found);
    return (
      g.owners.includes(userId) && isWorkspaceMember(g.workspace_id, userId)
    );
  });
}
/** Throws FamilyError(409,"unavailable") unless the supervised room is active. No-op for ordinary rooms. */
export function assertFamilyRunAllowed(roomId: string, userId?: string): void {
  const found = groupForRoom(roomId);
  if (!found) return;
  const g = tx(() => reconcile(found)); // committed before any throw
  if (g.status !== "active") unavailable();
  if (
    userId !== undefined &&
    (!g.owners.includes(userId) || !isWorkspaceMember(g.workspace_id, userId))
  )
    notFound();
  const room = getRoom(roomId);
  if (
    !room ||
    room.archived ||
    room.projectMode !== "off" ||
    room.agents.some((a) => a.tools) ||
    room.agents.length !== g.snapshot.length
  )
    unavailable();
  // Strict frozen-destination check (P1-1): no short-circuit when the
  // snapshot lacks a URL, and the room's agents must still use exactly the
  // approved provider id and model.
  for (const member of g.snapshot) {
    const agent = room!.agents.find((a) => a.id === member.agentId);
    if (
      !agent ||
      agent.provider !== member.provider ||
      agent.model !== member.model ||
      !endpointMatches(g.workspace_id, member)
    )
      unavailable();
  }
}
export function familyRoomPolicy(
  roomId: string,
  viewerUserId?: string,
): FamilyRoomPolicy | null {
  const found = groupForRoom(roomId);
  if (!found) return null;
  return tx(() => {
    const g = reconcile(found);
    return {
      groupId: g.id,
      status: g.status,
      revision: g.revision,
      canRun: g.status === "active",
      agentIds: [...g.members],
      redactPersonaAgentIds: g.snapshot
        .filter((s) => s.ownerUserId !== viewerUserId)
        .map((s) => s.agentId),
      tools: false,
      files: false,
      projectMode: "off",
      line: false,
      computers: false,
    };
  });
}
