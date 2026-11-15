import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { toView, formatAt } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import { convSubtitle, convTitle, lastPreview, publishBlock, visibilityNote, myBlock } from "../src/state/selectors.js";
import { ANN, BO, D1, G1, ME_ID, at, direct, emptySocial, group, notice, range, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const D2 = "00000000-0000-4000-8000-0000000000c3";

function model({ conversations, messages = [], social = emptySocial() }) {
  return M.applySocial(M.applySync(M.initial(), syncOf(conversations, messages)), social);
}

const pub = (id, handle, displayName) => ({ id, handle, displayName });

describe("people and identities", () => {
  it("shows the signed-in user under the alias id me, everyone else by id; agents is empty", () => {
    const v = toView(model({ conversations: [direct()] }), { now: NOW });
    expect(v.people[ME]).toMatchObject({ id: ME, kind: "person", name: "你", handle: "@me_one", displayName: "Mei", principalId: ME_ID });
    expect(v.people[ME_ID]).toBeUndefined();
    expect(v.people[ANN]).toMatchObject({ id: ANN, kind: "person", name: "小安", handle: "@ann", avatar: `/api/principals/${ANN}/avatar` });
    expect(v.people[ANN].cell).toHaveLength(2);
    expect(v.agents).toEqual({});
    expect(v.account).toMatchObject({ id: ME_ID, handle: "me_one", displayName: "Mei" });
    expect(v.loaded).toBe(true);
  });

  it("adds people known only from /api/social", () => {
    const CAT = "00000000-0000-4000-8000-0000000000a7";
    const v = toView(model({ conversations: [], social: { ...emptySocial(), incoming: [{ id: "r1", principal: pub(CAT, "cat", "小猫"), createdAt: at(1), expiresAt: at(2) }] } }), { now: NOW });
    expect(v.people[CAT]).toMatchObject({ name: "小猫", handle: "@cat" });
  });
});

describe("conversations", () => {
  it("maps a direct chat to type human with me and the peer as members, no title, no admin", () => {
    const v = toView(model({ conversations: [direct(D1, ANN, { lastSeq: 2, unread: 1 })], messages: range(D1, 1, 2) }), { now: NOW });
    const c = v.convs[D1];
    expect(c).toMatchObject({ id: D1, type: "human", title: null, admin: null, unread: 1, cutoffs: {}, hold: null });
    expect(c.members).toEqual([ME, ANN]);
    expect(convTitle(v, c)).toBe("小安");
  });

  it("maps a group to type group with its title and the creator as admin", () => {
    const v = toView(model({ conversations: [group(G1, { creatorId: ANN, members: [{ id: ANN, role: "speaker", isCreator: true }, { id: ME_ID, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }] })] }), { now: NOW });
    const c = v.convs[G1];
    expect(c).toMatchObject({ type: "group", title: "周末小组", admin: ANN });
    expect(c.members).toEqual([ANN, ME, BO]);
    expect(convSubtitle(v, c)).toBe("3 位真人");
    expect(visibilityNote(v, c)).toBeNull();
  });

  it("orders by last activity; empty conversations by createdAt when present, else the service's order", () => {
    const v = toView(
      model({
        conversations: [
          direct(D1, ANN, { lastSeq: 1 }),
          group(G1, { lastSeq: 1 }),
          direct(D2, BO, { createdAt: at(30) }),
          { ...direct("00000000-0000-4000-8000-0000000000c4", BO), peerId: BO },
        ],
        messages: [wire(D1, 1, ANN, "a", { createdAt: at(10) }), wire(G1, 1, ANN, "b", { createdAt: at(20) })],
      }),
      { now: NOW },
    );
    expect(v.order).toEqual([D2, G1, D1, "00000000-0000-4000-8000-0000000000c4"]);
    expect(v.convs[G1].at).toBe("09:20");
  });

  it("formats times like the prototype: today HH:MM, 昨天, then dates", () => {
    expect(formatAt(new Date(2026, 10, 16, 8, 5).getTime(), NOW)).toBe("08:05");
    expect(formatAt(new Date(2026, 10, 15, 23, 0).getTime(), NOW)).toBe("昨天");
    expect(formatAt(new Date(2026, 2, 3, 10, 0).getTime(), NOW)).toBe("3月3日");
    expect(formatAt(new Date(2025, 2, 3, 10, 0).getTime(), NOW)).toBe("2025/3/3");
    expect(formatAt(null, NOW)).toBe("");
  });
});

describe("messages", () => {
  it("text, file, image and system messages in the prototype's shape", () => {
    const FILE = "00000000-0000-4000-8000-0000000000f1";
    const IMG = "00000000-0000-4000-8000-0000000000f2";
    const v = toView(
      model({
        conversations: [group(G1, { lastSeq: 4 })],
        messages: [
          notice(G1, 1, "Mei创建了群聊「周末小组」", { event: "group_created", actorId: ME_ID, title: "周末小组", memberIds: [ANN, BO] }),
          wire(G1, 2, ANN, "早上好"),
          wire(G1, 3, BO, "", { kind: "file", attachment: { id: FILE, name: "报告.pdf", size: 1234, inline: false } }),
          wire(G1, 4, ME_ID, "看这个", { kind: "file", attachment: { id: IMG, name: "a.png", size: 99, inline: true }, replyTo: { seq: 2, visible: true, senderId: ANN, text: "早上好", kind: "text" } }),
        ],
      }),
      { now: NOW },
    );
    const [sys, text, file, image] = v.convs[G1].messages;
    expect(sys).toMatchObject({ id: "m1", seq: 1, from: null, kind: "system", text: "Mei创建了群聊「周末小组」", system: { event: "group_created", actorId: ME, memberIds: [ANN, BO] } });
    expect(text).toMatchObject({ id: "m2", from: ANN, kind: "text", text: "早上好", at: "09:02", status: "sent", replyTo: null, quote: null });
    expect(file).toMatchObject({ kind: "file", text: "报告.pdf", caption: "", attachment: { id: FILE, name: "报告.pdf", size: 1234, inline: false, url: `/api/attachments/${FILE}` } });
    expect(image).toMatchObject({ from: ME, kind: "image", text: "a.png", caption: "看这个", src: `/api/attachments/${IMG}`, replyTo: "m2" });
    expect(image.quote).toEqual({ seq: 2, visible: true, from: ANN, text: "早上好", kind: "text", attachmentName: null });
    expect(lastPreview(v, v.convs[G1])).toBe("你：[图片]");
  });

  it("a quote the reader cannot see says so", () => {
    const v = toView(model({ conversations: [group(G1, { lastSeq: 9 })], messages: [wire(G1, 9, ANN, "re", { replyTo: { seq: 2, visible: false } })] }), { now: NOW });
    expect(v.convs[G1].messages[0]).toMatchObject({ replyTo: "m2", quote: { seq: 2, visible: false } });
  });

  it("my messages in a direct chat read 已读 up to peerReadSeq; groups never do", () => {
    const v = toView(
      model({
        conversations: [direct(D1, ANN, { lastSeq: 3, peerReadSeq: 2 }), group(G1, { lastSeq: 1 })],
        messages: [wire(D1, 1, ME_ID), wire(D1, 2, ME_ID), wire(D1, 3, ME_ID), wire(G1, 1, ME_ID)],
      }),
      { now: NOW },
    );
    expect(v.convs[D1].messages.map((m) => m.status)).toEqual(["read", "read", "sent"]);
    expect(v.convs[G1].messages[0].status).toBe("sent");
  });

  it("unsent messages follow the server's as sending or failed, with their clientTxn", () => {
    let m = model({ conversations: [direct(D1, ANN, { lastSeq: 1 })], messages: [wire(D1, 1, ANN)] });
    m = M.markSending(m, { clientTxn: "t1", conversationId: D1, text: "在吗", replyToSeq: 1, at: NOW - 60_000 });
    m = M.markSending(m, { clientTxn: "t2", conversationId: D1, text: "喂", at: NOW });
    m = M.markFailed(m, "t2", { code: "network_error", reason: null });
    const msgs = toView(m, { now: NOW }).convs[D1].messages;
    expect(msgs.map((x) => x.id)).toEqual(["m1", "tx:t1", "tx:t2"]);
    expect(msgs[1]).toMatchObject({ from: ME, kind: "text", text: "在吗", status: "sending", clientTxn: "t1", replyTo: "m1", quote: { seq: 1, visible: true, from: ANN, text: "m1" } });
    expect(msgs[2]).toMatchObject({ status: "failed", clientTxn: "t2", error: { code: "network_error", reason: null } });
  });

  it("hides a sending message once its pushed copy is held (no visible duplicate before the HTTP answer)", () => {
    let m = model({ conversations: [direct(D1, ANN, { lastSeq: 1 })], messages: [wire(D1, 1, ANN)] });
    m = M.markSending(m, { clientTxn: "t1", conversationId: D1, text: "hi", at: NOW });
    m = M.markSending(m, { clientTxn: "t2", conversationId: D1, text: "hi", at: NOW + 1 });
    m = M.applyMessage(m, wire(D1, 2, ME_ID, "hi")).state;
    const msgs = toView(m, { now: NOW }).convs[D1].messages;
    expect(msgs.map((x) => x.id)).toEqual(["m1", "m2", "tx:t2"]);
  });
});

describe("social: relations, blocks and the hold", () => {
  const social = {
    friends: [pub(ANN, "ann", "小安")],
    incoming: [{ id: "r-in", principal: pub(BO, "bo", "阿波"), createdAt: at(1), expiresAt: at(2) }],
    outgoing: [],
    blocked: [pub(BO, "bo", "阿波")],
    blockedBy: [pub(ANN, "ann", "小安")],
  };

  it("relations keyed subject|target and blocks as {by, target} with the me alias", () => {
    const v = toView(model({ conversations: [], social }), { now: NOW });
    expect(v.relations[`${ME}|${ANN}`]).toEqual({ status: "established" });
    expect(v.relations[`${BO}|${ME}`]).toMatchObject({ status: "incoming", requestId: "r-in", expiresAt: at(2) });
    expect(v.blocks).toEqual([
      { by: ME, target: BO },
      { by: ANN, target: ME },
    ]);
    expect(myBlock(v, BO)).toBeTruthy();
  });

  it("outgoing requests are pending from me", () => {
    const v = toView(model({ conversations: [], social: { ...emptySocial(), outgoing: [{ id: "r-out", principal: pub(BO, "bo", "阿波"), createdAt: at(1), expiresAt: at(2) }] } }), { now: NOW });
    expect(v.relations[`${ME}|${BO}`]).toMatchObject({ status: "pending", requestId: "r-out" });
  });

  it("hold carries the service's refusal with its real reason; publishBlock returns it", () => {
    const v = toView(
      model({
        conversations: [
          direct(D1, ANN, { canSend: { ok: false, reason: "blocked" } }),
          direct(D2, BO, { canSend: { ok: false, reason: "blocked" } }),
          direct("00000000-0000-4000-8000-0000000000c5", BO, { canSend: { ok: false, reason: "not_friends" } }),
          group(G1),
        ],
        social,
      }),
      { now: NOW },
    );
    expect(v.convs[D1].hold).toMatchObject({ kind: "block", reason: "blocked", pending: ["小安拉黑了你，只能由对方解除"] });
    expect(v.convs[D1].hold.text).toContain("小安拉黑了你，只能由对方解除");
    expect(v.convs[D2].hold).toMatchObject({ kind: "block", pending: ["你已拉黑 阿波"] });
    expect(v.convs["00000000-0000-4000-8000-0000000000c5"].hold).toMatchObject({ kind: "relation", reason: "not_friends" });
    expect(v.convs["00000000-0000-4000-8000-0000000000c5"].hold.text).toContain("对方已不是你的好友");
    // a block between members never stops a group in batch 1
    expect(v.convs[G1].hold).toBeNull();
    expect(publishBlock(v, v.convs[G1])).toBeNull();
    expect(publishBlock(v, v.convs[D1])).toBe(v.convs[D1].hold);
  });

  it("a send refused with cannot_send shows at once", () => {
    let m = model({ conversations: [direct(D1, ANN)], social: { ...emptySocial(), friends: [pub(ANN, "ann", "小安")] } });
    m = M.setCanSend(m, D1, { ok: false, reason: "not_friends" });
    expect(toView(m, { now: NOW }).convs[D1].hold.kind).toBe("relation");
  });
});
