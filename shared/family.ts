// Agent Family "family" layer: invitation-only, single-instance, centrally
// supervised relationships between independently owned Agents.
// This is NOT the v9 distributed Matrix E2EE supervision model; see
// docs/design/2026-11-15-family-api.md for the trust boundary.
import { z } from "zod";

export const FAMILY_LIMITS = {
  agentsPerOwner: 20,
  groupMinAgents: 2,
  groupMaxAgents: 5,
  proposalTtlMs: 24 * 60 * 60 * 1000,
  pendingFriendRequestsPerOwner: 50,
  openProposalsPerOwner: 20,
  /** Active + paused supervised groups any single owner may belong to. */
  activeGroupsPerOwner: 20,
  nameMax: 20,
  groupNameMax: 40,
  personaMax: 4000,
  modelMax: 180,
  noteMax: 200,
  reasonMax: 200,
  clientRequestIdMax: 64,
} as const;

/** Stable machine-readable error codes returned as `{ error, code }`. */
export type FamilyErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "conflict"
  | "stale_revision"
  | "unavailable"
  | "expired"
  | "limit";

export type FamilyCapabilities = {
  release: "af-family-v1";
  supervision: "central-single-instance";
  e2ee: false;
  matrixFederation: false;
  invitationOnly: true;
  groupAgents: { min: number; max: number };
  proposalTtlHours: number;
  crossOwner: {
    tools: false;
    files: false;
    projectMode: "off";
    line: false;
    physicalComputers: false;
    virtualComputers: false;
  };
  deferredV9Gates: string[];
};

export const FAMILY_CAPABILITIES: FamilyCapabilities = {
  release: "af-family-v1",
  supervision: "central-single-instance",
  e2ee: false,
  matrixFederation: false,
  invitationOnly: true,
  groupAgents: {
    min: FAMILY_LIMITS.groupMinAgents,
    max: FAMILY_LIMITS.groupMaxAgents,
  },
  proposalTtlHours: 24,
  crossOwner: {
    tools: false,
    files: false,
    projectMode: "off",
    line: false,
    physicalComputers: false,
    virtualComputers: false,
  },
  deferredV9Gates: [
    "matrix-e2ee-rooms",
    "multi-homeserver-federation",
    "per-owner-device-key-verification",
    "owner-held-supervision-keys",
    "cross-owner-tools-files-computers",
  ],
};

export type FamilyAgentColor = "sage" | "clay" | "blue" | "violet" | "gold";

/**
 * How an owner is identified everywhere in the family layer.
 * - `ownerName` is the account's *current* display name, read at view time
 *   (never a copy frozen at agent creation, so a later rename cannot linger).
 * - `ownerTag` is a short, random, stable per-workspace member tag (e.g.
 *   "K7Q2"). It is not derived from the user id or email and reveals neither.
 *   Two members can share a display name but never a tag.
 * - `ownerNameDuplicate` is true when another member (or another Agent owner
 *   in this workspace) currently uses the same display name; UIs should then
 *   ask the user to compare tags.
 */
export type FamilyOwnerIdentity = {
  ownerName: string;
  ownerTag: string;
  ownerNameDuplicate: boolean;
};

/** Full view: returned only to the immutable owner. */
export type FamilyAgentOwnerView = FamilyOwnerIdentity & {
  id: string;
  isMine: true;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  model: string;
  provider: string;
  persona: string;
  color: FamilyAgentColor;
  enabled: boolean;
  tools: false;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Directory view for other authenticated workspace members (no ids, email, persona, model or provider). */
export type FamilyAgentPublicView = FamilyOwnerIdentity & {
  id: string;
  isMine: false;
  name: string;
  color: FamilyAgentColor;
};

export type FamilyAgentView = FamilyAgentOwnerView | FamilyAgentPublicView;

export type FamilyFriendshipStatus =
  "pending" | "accepted" | "rejected" | "cancelled" | "removed";

export type FamilyFriendshipView = {
  id: string;
  status: FamilyFriendshipStatus;
  requesterAgentId: string;
  agents: [
    FamilyAgentPublicView | FamilyAgentOwnerView,
    FamilyAgentPublicView | FamilyAgentOwnerView,
  ];
  /** True when the caller owns the side that still has to accept. */
  canAccept: boolean;
  createdAt: string;
  updatedAt: string;
};

export type FamilyGroupKind = "dm" | "group";
export type FamilyGroupStatus =
  | "proposed"
  | "active"
  | "paused"
  | "archived"
  | "rejected"
  | "cancelled"
  | "expired";

/**
 * Frozen disclosure the owners approve (membership + model + exact endpoint).
 * Every proposal freezes `providerUrl` and `providerKind`; runs are refused
 * unless the workspace provider still has exactly that URL and protocol.
 * They can be absent only on snapshots written before this rule existed;
 * such groups are never runnable and are moved to re-approval or refused.
 */
export type FamilySnapshotMember = FamilyOwnerIdentity & {
  agentId: string;
  /** Room-local display name (disambiguated if two Agents share a name). */
  name: string;
  color: FamilyAgentColor;
  model: string;
  provider: string;
  providerUrl?: string;
  /** Wire protocol: "compatible" | "openai" | "anthropic" | "google". */
  providerKind?: string;
  isMine: boolean;
};

/**
 * What the caller may attempt right now, from their role and the group status.
 * Viewer owners keep every stop right (reject, pause, archive) but never get
 * approve / resume / expand. The server can still refuse with 409 unavailable
 * (for example while a block or provider change persists).
 */
export type FamilyGroupActions = {
  approve: boolean;
  reject: boolean;
  pause: boolean;
  resume: boolean;
  archive: boolean;
  expand: boolean;
};

export type FamilyGroupView = {
  id: string;
  kind: FamilyGroupKind;
  name: string;
  status: FamilyGroupStatus;
  revision: number;
  /** Opaque, server-salted commitment to the disclosure; quote it back on approve/resume. */
  snapshotHash: string;
  members: FamilySnapshotMember[];
  owners: {
    name: string;
    tag: string;
    nameDuplicate: boolean;
    isMe: boolean;
    approvedCurrentRevision: boolean;
  }[];
  myApprovalNeeded: boolean;
  can: FamilyGroupActions;
  /** AF room bound at activation; null while proposed/never activated. */
  roomId: string | null;
  parentGroupId: string | null;
  expiresAt: string | null;
  canRun: boolean;
  /**
   * `myReasons` only lists causes the caller created (their pause, block,
   * disabled Agent, or their own read-only role). `sharedReasons` lists
   * non-private causes every owner may see (a model-service endpoint change,
   * or re-approval needed to disclose an endpoint). Anything else is shown
   * only as `unavailable:true`.
   */
  availability: {
    unavailable: boolean;
    myReasons: string[];
    sharedReasons: string[];
  };
  createdAt: string;
  updatedAt: string;
};

export type FamilyBlockView = {
  id: string;
  scope: "agent" | "owner";
  targetAgentId: string;
  /** Agent name (scope "agent") or the owner's current name (scope "owner"). */
  targetName: string;
  /** Member tag of the blocked Agent's owner. */
  targetOwnerTag: string;
  note: string;
  createdAt: string;
};

/** Minimal policy for orchestrator/room integration. */
export type FamilyRoomPolicy = {
  groupId: string;
  status: FamilyGroupStatus;
  revision: number;
  canRun: boolean;
  agentIds: string[];
  /** Agent ids whose persona must be redacted for the given viewer. */
  redactPersonaAgentIds: string[];
  tools: false;
  files: false;
  projectMode: "off";
  line: false;
  computers: false;
};

// ---------- Zod request schemas (shared by server + client) ----------
const idSchema = z.string().uuid();
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(FAMILY_LIMITS.nameMax)
  .refine((v) => !/[\s@]/.test(v), "名字不能包含空格或 @");
const colorSchema = z.enum(["sage", "clay", "blue", "violet", "gold"]);
const clientRequestId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .optional();

export const familyAgentCreateSchema = z
  .object({
    name: nameSchema,
    model: z.string().trim().max(FAMILY_LIMITS.modelMax).default(""),
    provider: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .default("canal"),
    persona: z.string().max(FAMILY_LIMITS.personaMax).default(""),
    color: colorSchema.default("sage"),
  })
  .strict();

export const familyAgentUpdateSchema = z
  .object({
    name: nameSchema.optional(),
    model: z.string().trim().max(FAMILY_LIMITS.modelMax).optional(),
    provider: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .optional(),
    persona: z.string().max(FAMILY_LIMITS.personaMax).optional(),
    color: colorSchema.optional(),
    enabled: z.boolean().optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .strict();

export const familyFriendRequestSchema = z
  .object({ fromAgentId: idSchema, toAgentId: idSchema })
  .strict();

export const familyGroupCreateSchema = z
  .object({
    kind: z.enum(["dm", "group"]).default("group"),
    name: z.string().trim().min(1).max(FAMILY_LIMITS.groupNameMax),
    agentIds: z
      .array(idSchema)
      .min(FAMILY_LIMITS.groupMinAgents)
      .max(FAMILY_LIMITS.groupMaxAgents),
    clientRequestId,
  })
  .strict();

export const familyRevisionSchema = z
  .object({
    revision: z.number().int().min(1),
    snapshotHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const familyPauseSchema = z
  .object({ reason: z.string().max(FAMILY_LIMITS.reasonMax).optional() })
  .strict();

export const familyExpandSchema = z
  .object({
    addAgentIds: z
      .array(idSchema)
      .min(1)
      .max(FAMILY_LIMITS.groupMaxAgents - 1),
    name: z.string().trim().min(1).max(FAMILY_LIMITS.groupNameMax).optional(),
    clientRequestId,
  })
  .strict();

export const familyBlockSchema = z
  .object({
    scope: z.enum(["agent", "owner"]),
    agentId: idSchema,
    note: z.string().max(FAMILY_LIMITS.noteMax).default(""),
  })
  .strict();

export type FamilyAgentCreate = z.infer<typeof familyAgentCreateSchema>;
export type FamilyAgentUpdate = z.infer<typeof familyAgentUpdateSchema>;
export type FamilyGroupCreate = z.infer<typeof familyGroupCreateSchema>;
export type FamilyExpand = z.infer<typeof familyExpandSchema>;
export type FamilyBlockCreate = z.infer<typeof familyBlockSchema>;

/**
 * Routes (all JSON, all require an authenticated workspace member unless noted):
 *  GET    /api/family/capabilities                 -> { capabilities }   (no auth)
 *  GET    /api/family/agents                       -> { agents }
 *  POST   /api/family/agents                       -> { agents: [agent] }
 *  PATCH  /api/family/agents/:id                   -> { agents: [agent] }
 *  GET    /api/family/friendships                  -> { friendships }
 *  POST   /api/family/friendships                  -> { friendships: [f] }
 *  POST   /api/family/friendships/:id/accept|reject|cancel|remove -> { friendships: [f] }
 *  GET    /api/family/groups                       -> { groups }
 *  POST   /api/family/groups                       -> { groups: [g] }
 *  GET    /api/family/groups/:id                   -> { groups: [g] }
 *  POST   /api/family/groups/:id/approve           -> { groups: [g] }
 *  POST   /api/family/groups/:id/reject            -> { groups: [g] }
 *  POST   /api/family/groups/:id/pause             -> { groups: [g] }
 *  POST   /api/family/groups/:id/resume            -> { groups: [g] }
 *  POST   /api/family/groups/:id/expand            -> { groups: [newProposal] }
 *  POST   /api/family/groups/:id/archive           -> { groups: [g] }
 *  GET    /api/family/blocks                       -> { blocks }
 *  POST   /api/family/blocks                       -> { blocks: [b] }
 *  DELETE /api/family/blocks/:id                   -> { blocks: [] }
 * Errors: HTTP status + `{ error: string, code: FamilyErrorCode }`.
 */
export const FAMILY_ROUTES = [
  "GET /api/family/capabilities",
  "GET /api/family/agents",
  "POST /api/family/agents",
  "PATCH /api/family/agents/:id",
  "GET /api/family/friendships",
  "POST /api/family/friendships",
  "POST /api/family/friendships/:id/accept",
  "POST /api/family/friendships/:id/reject",
  "POST /api/family/friendships/:id/cancel",
  "POST /api/family/friendships/:id/remove",
  "GET /api/family/groups",
  "POST /api/family/groups",
  "GET /api/family/groups/:id",
  "POST /api/family/groups/:id/approve",
  "POST /api/family/groups/:id/reject",
  "POST /api/family/groups/:id/pause",
  "POST /api/family/groups/:id/resume",
  "POST /api/family/groups/:id/expand",
  "POST /api/family/groups/:id/archive",
  "GET /api/family/blocks",
  "POST /api/family/blocks",
  "DELETE /api/family/blocks/:id",
] as const;
