import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { db, audit } from "./db";
import { now } from "./config";

type Context = {
  user: { id: string; name: string };
  workspaceId: string;
  role: string;
};
type Options = {
  homeserver: string;
  serverName: string;
  elementUrl: string;
  registrationSecret: string;
};
const failure = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });
export function matrixOptions(): Options | null {
  const homeserver = process.env.MATRIX_HOMESERVER_URL || "";
  const serverName = process.env.MATRIX_SERVER_NAME || "";
  const elementUrl = process.env.MATRIX_ELEMENT_URL || "";
  const registrationSecret = process.env.MATRIX_REGISTRATION_SECRET || "";
  if (!homeserver || !serverName || !elementUrl || !registrationSecret)
    return null;
  for (const value of [homeserver, elementUrl]) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw failure(503, "聊天服务配置暂不可用，请联系部署管理员。");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search
    )
      throw failure(503, "聊天服务配置暂不可用，请联系部署管理员。");
  }
  return {
    homeserver: homeserver.replace(/\/$/, ""),
    serverName,
    elementUrl,
    registrationSecret,
  };
}
export const matrixLocalpart = (userId: string) =>
  `af_${crypto.createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;
export function registrationMac(
  secret: string,
  nonce: string,
  username: string,
  password: string,
) {
  return crypto
    .createHmac("sha1", secret)
    .update([nonce, username, password, "notadmin"].join("\0"))
    .digest("hex");
}

/** Reuse Synapse's shared-secret registration; never store or log human passwords/tokens. */
export async function provisionMatrixAccount(
  options: Options,
  userId: string,
  name: string,
  password: string,
  request = fetch,
) {
  const username = matrixLocalpart(userId);
  const expectedId = `@${username}:${options.serverName}`;
  const call = async (url: string, body?: unknown) => {
    const response = await request(options.homeserver + url, {
      method: body ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    const data = (await response.json().catch(() => ({}))) as any;
    return { response, data };
  };
  const { response: nonceResponse, data: nonceData } = await call(
    "/_synapse/admin/v1/register",
  );
  if (!nonceResponse.ok || typeof nonceData.nonce !== "string")
    throw failure(502, "聊天服务暂时不可用，请稍后重试。");
  const { response, data } = await call("/_synapse/admin/v1/register", {
    nonce: nonceData.nonce,
    username,
    password,
    admin: false,
    displayname: name.slice(0, 60),
    mac: registrationMac(
      options.registrationSecret,
      nonceData.nonce,
      username,
      password,
    ),
    inhibit_login: true,
  });
  if (!response.ok) {
    // An ambiguous prior response may have created the account. Authenticate the
    // deterministic identity with the SAME password; never reset/take over it.
    if (data.errcode !== "M_USER_IN_USE")
      throw failure(502, "未能创建聊天账户，请稍后重试。");
    const recovered = await call("/_matrix/client/v3/login", {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: expectedId },
      password,
      initial_device_display_name: "Agent Family account verification",
    });
    if (!recovered.response.ok || recovered.data.user_id !== expectedId)
      throw failure(
        409,
        "聊天账户可能已经创建。请用上次设置的密码重试；不会覆盖现有账户。",
      );
    if (typeof recovered.data.access_token === "string") {
      await request(options.homeserver + "/_matrix/client/v3/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${recovered.data.access_token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      }).catch(() => undefined);
    }
  } else if (data.user_id !== expectedId) {
    throw failure(502, "聊天服务返回了不一致的账户标识，已停止连接。");
  } else if (typeof data.access_token === "string") {
    await request(options.homeserver + "/_matrix/client/v3/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${data.access_token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    }).catch(() => undefined);
  }
  return expectedId;
}

export function registerMatrixRoutes(
  app: FastifyInstance,
  context: (req: FastifyRequest) => Promise<Context>,
) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS matrix_accounts(user_id TEXT PRIMARY KEY,matrix_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL)`,
  );
  const inFlight = new Set<string>();
  app.get("/api/matrix/account", async (req) => {
    const c = await context(req);
    const options = matrixOptions();
    const account = db
      .prepare(
        "SELECT matrix_id AS matrixId,created_at AS createdAt FROM matrix_accounts WHERE user_id=?",
      )
      .get(c.user.id);
    return {
      configured: !!options,
      account: account || null,
      homeserver: options?.homeserver,
      elementUrl: options?.elementUrl,
      agentAutomation: false,
      federation: "matrix-human-chat",
      supervisedGroups: "af-hosted",
    };
  });
  app.post(
    "/api/matrix/account",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req) => {
      const c = await context(req);
      if (c.role === "viewer") throw failure(403, "只读成员不能开通聊天账户。");
      const options = matrixOptions();
      if (!options) throw failure(503, "Matrix 聊天服务尚未配置。");
      const { password } = z
        .object({
          password: z
            .string()
            .min(12)
            .max(128)
            .refine((v) => !v.includes("\0")),
        })
        .parse(req.body);
      const existing = db
        .prepare(
          "SELECT matrix_id AS matrixId FROM matrix_accounts WHERE user_id=?",
        )
        .get(c.user.id);
      if (existing) return existing;
      if (inFlight.has(c.user.id)) throw failure(409, "正在开通，请稍候。");
      inFlight.add(c.user.id);
      try {
        const matrixId = await provisionMatrixAccount(
          options,
          c.user.id,
          c.user.name,
          password,
        );
        db.prepare("INSERT INTO matrix_accounts VALUES(?,?,?)").run(
          c.user.id,
          matrixId,
          now(),
        );
        audit(c.workspaceId, c.user.id, "matrix.account.create", matrixId);
        return { matrixId };
      } finally {
        inFlight.delete(c.user.id);
      }
    },
  );
}
