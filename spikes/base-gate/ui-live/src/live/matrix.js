// Gate-verification spike: feeds the approved prototype UI from a real Synapse server
// through matrix-js-sdk. Throwaway code; it only covers conversations, timeline and sending.
import * as sdk from "matrix-js-sdk";
import { makeAgent } from "../data/identities.js";

const isSystem = (id) => /^@af_system:/.test(id);
const isAgentId = (id) => /^@agent_/.test(id);
const HUMAN_CELLS = [[1, 0], [2, 0]];
const AGENT_CELLS = [[0, 1], [1, 1], [2, 1], [0, 2], [1, 2]];
const hash = (s) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
const hhmm = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export async function connectMatrix({ baseUrl, user, password }) {
  const res = await fetch(`${baseUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "m.login.password", identifier: { type: "m.id.user", user }, password }),
  });
  const login = await res.json();
  if (!res.ok) throw new Error(login.error || "登录失败");

  const client = sdk.createClient({ baseUrl, accessToken: login.access_token, userId: login.user_id, deviceId: login.device_id });
  const me = login.user_id;
  const lid = (id) => (id === me ? "me" : id); // the prototype hardcodes the viewer as "me"
  const listeners = new Set();

  function build() {
    const people = { me: { id: "me", kind: "person", name: "你", handle: me, cell: [0, 0] } };
    const agents = {};
    const convs = {};
    const relations = {};
    const rooms = client.getRooms().filter((r) => r.getMyMembership() === "join");
    rooms.sort((a, b) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp());

    for (const room of rooms) {
      const roles = room.currentState.getStateEvents("af.roles", "")?.getContent() || {};
      const observers = roles.observers || [];
      const owners = roles.owners || {};
      const joined = room.getJoinedMembers().filter((m) => !isSystem(m.userId));
      for (const m of joined) {
        const id = lid(m.userId);
        if (isAgentId(m.userId)) {
          agents[id] = makeAgent({ id, name: m.name, ownerId: lid(owners[m.userId] || "unknown"), handle: m.userId, cell: AGENT_CELLS[hash(m.userId) % AGENT_CELLS.length] });
        } else if (id !== "me") {
          people[id] = { id, kind: "person", name: m.name, handle: m.userId, cell: HUMAN_CELLS[hash(m.userId) % HUMAN_CELLS.length] };
        }
      }
      // Speaking members exclude owners who are present only to observe.
      const speaking = joined.filter((m) => !observers.includes(m.userId)).map((m) => lid(m.userId));
      const ag = speaking.filter((id) => agents[id]);
      const hu = speaking.filter((id) => !agents[id]);
      let type = "mixed";
      if (ag.length === 0 && hu.length === 2) type = "human";
      else if (hu.length === 1 && hu[0] === "me" && ag.length === 1) type = "agent";
      else if (hu.length === 0 && ag.length === 2) type = "pair";
      else if (hu.length === 0 && ag.length > 2) type = "agentGroup";
      if (type === "human" || type === "agent") relations[`me|${speaking.find((x) => x !== "me")}`] = { status: "established" };

      const messages = room
        .getLiveTimeline()
        .getEvents()
        .filter((ev) => ev.getType() === "m.room.message")
        .map((ev) => {
          const c = ev.getContent();
          const sender = ev.getSender();
          if (isSystem(sender)) return { id: ev.getId(), from: null, kind: "system", text: c.body, at: hhmm(ev.getTs()) };
          return {
            id: ev.getId(),
            from: lid(sender),
            kind: c.msgtype === "m.file" || c.msgtype === "m.image" ? "file" : "text",
            text: c.body,
            at: hhmm(ev.getTs()),
            status: ev.status === "not_sent" ? "failed" : "sent",
            interject: observers.includes(sender),
          };
        });

      convs[room.roomId] = {
        id: room.roomId,
        type,
        title: type === "human" || type === "agent" ? undefined : room.name,
        members: speaking,
        admin: null,
        at: messages.length ? messages[messages.length - 1].at : "",
        unread: room.getUnreadNotificationCount("total") || 0,
        hold: null,
        visibility: "ok",
        expansion: null,
        discussion: null,
        recovery: null,
        myPause: false,
        generating: null,
        version: 1,
        cutoffs: {},
        messages,
      };
    }
    return { people, agents, convs, order: rooms.map((r) => r.roomId), relations };
  }

  let timer = null;
  const publish = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const snap = build();
      listeners.forEach((fn) => fn(snap));
    }, 40);
  };
  ["sync", "Room.timeline", "Room.localEchoUpdated", "RoomState.events", "Room.myMembership", "Room.receipt", "Room.name"].forEach((name) => client.on(name, publish));
  await client.startClient({ initialSyncLimit: 50 });

  return {
    me,
    subscribe(fn) {
      listeners.add(fn);
      publish();
      return () => listeners.delete(fn);
    },
    send: (convId, text) => client.sendTextMessage(convId, text),
    markRead(convId) {
      const events = client.getRoom(convId)?.getLiveTimeline().getEvents() || [];
      const last = events[events.length - 1];
      if (last) client.sendReadReceipt(last).catch(() => {});
    },
    stop: () => client.stopClient(),
  };
}
