// Destructive probes. Runs against PRIVATE throwaway instances of server.mjs (spawned here on other ports),
// never against the shared one on 9300.   node adversarial/crash.mjs
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(port, fn) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), CORE_ADMIN_SECRET: "private-test" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", exit = null;
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", (code) => (exit = code));
  for (let i = 0; i < 100 && !log.includes("listening"); i++) await sleep(100);
  const base = `http://127.0.0.1:${port}`;
  const alive = async () => { try { return (await fetch(`${base}/sync`)).status; } catch (e) { return `DEAD (${e.cause?.code || e.message})`; } };
  try { return await fn({ base, port, alive, state: () => ({ exit, tail: log.split("\n").filter((l) => /Error|error|TypeError|RangeError/.test(l)).slice(0, 3) }) }); } finally { child.kill(); }
}
const rawSend = (port, data, waitMs = 500) => new Promise((resolve) => {
  const sock = net.connect(port, "127.0.0.1");
  let got = "";
  sock.on("data", (d) => (got += d.toString("latin1")));
  sock.on("error", () => {});
  sock.on("connect", async () => { for (const part of [].concat(data)) { sock.write(part); await sleep(150); } await sleep(waitMs); sock.destroy(); resolve(got.split("\r\n")[0]); });
});

// 1. unauthenticated request lines that make `new URL(req.url, ...)` throw outside the try/catch
for (const target of ["//", "http://", "//[", "/ok"]) {
  await withServer(9391, async ({ port, alive, state }) => {
    const before = await alive();
    const first = await rawSend(port, `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
    await sleep(300);
    console.log(JSON.stringify({ test: "no-token request target", target, before, response: first, after: await alive(), ...state() }));
  });
}

// 2. any valid token: open a websocket and send one protocol-invalid (unmasked) frame
await withServer(9392, async ({ base, port, alive, state }) => {
  const adm = (p, b) => fetch(base + p, { method: "POST", headers: { "x-admin": "private-test" }, body: JSON.stringify(b) }).then((r) => r.json());
  await adm("/admin/principals", { kind: "human", handle: "u", name: "u", password: "pw-private" });
  const { token } = await (await fetch(`${base}/login`, { method: "POST", body: JSON.stringify({ handle: "u", password: "pw-private" }) })).json();
  const before = await alive();
  const hs = `GET /ws?token=${token} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  const first = await rawSend(port, [hs, Buffer.from([0x81, 0x01, 0x41])]);
  await sleep(300);
  console.log(JSON.stringify({ test: "ordinary-token websocket, one unmasked frame", before, handshake: first, after: await alive(), ...state() }));
});
process.exit(0);
