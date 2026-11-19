// An Agent's memory (记忆宫殿) in a real browser against the real service. The model is the local stub (support/model-stub.mjs):
// besides the replies it answers the memory review and the hearsay call (`modelStub.memoryAnswer`, matched by what the
// conversation said, so a late call of another test never takes it), and the judgement model is the judgement stub
// (support/judge-stub.mjs), whose memory rules are: a note holding `VAULT_MARK` is private, any other is not; a new group
// message holding `LISTEN_MARK` is something said about its owner. The site's MEMORY configuration (support/system.mjs)
// (restarted for this file with MEMORY) makes a review come one second after a conversation goes quiet.
//   A. a preference told to the Agent becomes a note (the chip, its line), and the next reply is given it
//   B. the vault: a note locked in the palace, and one the judgement locked by itself, never reach a group's reply
//   C. 撤销 on the chip removes the note
//   D. hearsay: what a member says about the owner in a group reaches the owner's own conversation and palace, and nobody else
import { test, expect } from "./support/fixtures.mjs";
import { befriend, createGroupApi, uniq } from "./support/accounts.mjs";
import { agentMessagesWith, createAgentUi, goTo, listRow, messageList, newTopicUi, openAgentDetail, openChat, sendText } from "./support/app.mjs";
import { canControlService, restartService } from "./support/control.mjs";
import { LISTEN_MARK, VAULT_MARK, judgeStub } from "./support/judge-stub.mjs";
import { modelStub } from "./support/model-stub.mjs";

// The site's MEMORY for this file: a review one second after a conversation goes quiet (the suite's default is ten minutes, so
// no other spec has a review); the base configuration again when the file is done.
test.beforeAll(async () => {
  if (canControlService) await restartService({ MEMORY: JSON.stringify({ quietMs: 1000, groupQuietMs: 1000, dreamSweepMs: 86_400_000 }) });
});
test.afterAll(async () => {
  if (canControlService) await restartService({});
});

test.beforeEach(async () => {
  test.skip(!canControlService, "needs the local service, its model stub and its judgement stub");
  await modelStub.reset();
  await judgeStub.reset();
});

// --- helpers -----------------------------------------------------------------------------------------------------------

/** What a review answers when it adds these notes (`kind` "owner": about the owner). */
const adds = (...texts) => JSON.stringify({ ops: texts.map((text) => ({ op: "add", kind: "owner", text })) });

/**
 * The memory calls of `kind` whose conversation held `tag`. (After the service was restarted for this file it looked at the
 * conversations of earlier specs once more: their reviews are in the record too, and are not this test's.)
 */
async function callsAbout(kind, tag) {
  return (await modelStub.memoryCalls(kind)).filter((c) => JSON.stringify(c.body?.messages ?? []).includes(tag));
}

/** The memory chips of an open conversation. */
const chips = (chat) => chat.locator("li.msg-memory .memory-chip");

/** The notes object a reply was given (`about_owner`, `own_notes`, `heard`): parsed from the one JSON line of its system text. */
function notesGiven(call) {
  const messages = Array.isArray(call.body?.messages) ? call.body.messages : [];
  const flat = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? "").join("") : "");
  const system = [flat(call.body?.system), ...messages.filter((m) => m.role === "system").map((m) => flat(m.content))].join("\n");
  for (const line of system.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && ("about_owner" in parsed || "own_notes" in parsed || "heard" in parsed)) return parsed;
    } catch {
      // (not the notes' line)
    }
  }
  return {};
}
const aboutOwner = (call) => (notesGiven(call).about_owner ?? []);

/** Settings → 记忆宫殿: the room 关于我. */
async function openPalace(page) {
  await goTo(page, "设置");
  await page.getByRole("button", { name: /记忆宫殿/ }).click();
  const room = page.getByRole("region", { name: "关于我", exact: true });
  await expect(room).toBeVisible();
  return room;
}
const rowOf = (room, text) => room.locator("li.memory-row").filter({ hasText: text });

/** Ann, who has an Agent named `name`, and one friend; the Agent's conversation is open on Ann's page. */
async function annWithAgent(people, { open = true } = {}) {
  const ann = await people.member("Ann");
  const bo = await people.member("Bo", { open });
  await befriend(ann, bo);
  const name = `小记${uniq(4)}`;
  const chat = await createAgentUi(ann.page, { name, intro: "帮我记事", persona: "你是一个爱记事的助手。" });
  const { agents } = await (await ann.request.get("/api/agents")).json();
  const agent = agents.find((a) => a.name === name);
  expect(agent, "the Agent Ann created").toBeDefined();
  return { ann, bo, name, chat, agent };
}

/** Ann's group with Bo, a third friend (a group starts with two of its creator's friends) and her Agent: resolves with its title. */
async function groupWithAgent(people, ann, bo, agent) {
  const cy = await people.member("Cy", { open: false });
  await befriend(ann, cy);
  const title = `闲聊群${uniq(4)}`;
  const groupId = await createGroupApi(ann, [bo, cy], title);
  const added = await ann.request.post(`/api/conversations/${groupId}/members`, { data: { principalId: agent.id } });
  expect(added.status(), await added.text()).toBe(201);
  return title;
}

/** Everything `context`'s pages receive from now on that comes from the service: WebSocket frames and `/api/` answers. */
function recordTraffic(context) {
  const bodies = [];
  const frames = [];
  const reading = [];
  const watch = (page) => {
    page.on("response", (response) => {
      if (!new URL(response.url()).pathname.startsWith("/api/")) return;
      reading.push(
        response.body().then(
          (body) => bodies.push(`${response.url()}\n${body.toString("utf8")}`),
          () => {},
        ),
      );
    });
    page.on("websocket", (ws) => ws.on("framereceived", (frame) => frames.push(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8"))));
  };
  context.on("page", watch);
  for (const page of context.pages()) watch(page);
  return {
    frames,
    async api() {
      await Promise.all(reading);
      return bodies;
    },
  };
}

// --- A ------------------------------------------------------------------------------------------------------------------

test("A. a preference told to the Agent is remembered: the chip shows it, and the reply after a new topic is given the note", async ({ people }) => {
  const { ann, name, chat } = await annWithAgent(people);
  const tag = uniq(6);
  const note = `主人不吃辣 ${tag}`;
  await modelStub.memoryAnswer("review", tag, adds(note));

  await modelStub.reply(`好的，我记着。${tag}`);
  await sendText(ann.page, name, `我不吃辣，点菜的时候帮我避开 ${tag}`);
  await expect(agentMessagesWith(chat, `好的，我记着。${tag}`)).toHaveCount(1);

  // About a second after the conversation went quiet: the chip, with the Agent's name; opened, the line.
  const chip = chips(chat);
  await expect(chip).toHaveCount(1, { timeout: 40_000 });
  await expect(chip).toContainText(name);
  await chip.click();
  await expect(chat.locator(".memory-detail")).toContainText(`记住了：${note}`);
  expect(await callsAbout("review", tag), "one review call").toHaveLength(1);

  // A new topic; the next reply is given the note (the system text carries it, read from the one JSON object in it).
  await newTopicUi(ann.page, chat);
  await modelStub.reply(`周末可以去公园野餐。${tag}`);
  await sendText(ann.page, name, `换个话题：周末去哪玩比较好 ${tag}`);
  await expect(agentMessagesWith(chat, `周末可以去公园野餐。${tag}`)).toHaveCount(1);
  const calls = await modelStub.waitForCalls(2);
  expect(aboutOwner(calls[0]), "the first reply knew nothing yet").toEqual([]);
  expect(aboutOwner(calls[1])).toContain(note);
});

// --- B ------------------------------------------------------------------------------------------------------------------

test("B. the vault: a note the owner locked in the palace and one the judgement locked by itself are never given to a group's reply; a note outside is", async ({ people }) => {
  const { ann, bo, name, chat, agent } = await annWithAgent(people);
  const tag = uniq(6);
  const open = `主人不吃辣 ${tag}`;
  const toLock = `主人爱喝美式咖啡 ${tag}`;
  const private_ = `主人下周要去${VAULT_MARK} ${tag}`;
  await modelStub.memoryAnswer("review", tag, adds(open, toLock, private_));

  await modelStub.reply(`好的。${tag}`);
  await sendText(ann.page, name, `我不吃辣，爱喝美式，下周还要去${VAULT_MARK} ${tag}`);
  const chip = chips(chat);
  await expect(chip).toHaveCount(1, { timeout: 40_000 });
  await chip.click();
  const lines = chat.locator(".memory-detail .memory-lines li");
  await expect(lines).toHaveCount(3);
  // The judgement put the private one in the vault by itself: its line carries the tag, the others' do not.
  await expect(lines.filter({ hasText: private_ })).toContainText("保险箱");
  await expect(lines.filter({ hasText: open })).not.toContainText("保险箱");
  await expect(lines.filter({ hasText: toLock })).not.toContainText("保险箱");

  // The palace: the private note is in the vault block already; the owner puts the coffee note there.
  const room = await openPalace(ann.page);
  const vault = room.locator(".memory-vault");
  const outside = room.locator(".memory-open");
  await expect(rowOf(outside, open)).toHaveCount(1);
  await expect(rowOf(outside, toLock)).toHaveCount(1);
  await expect(rowOf(vault, private_)).toHaveCount(1);
  await expect(rowOf(outside, private_)).toHaveCount(0);
  await rowOf(outside, toLock).getByRole("button", { name: "放进保险箱" }).click();
  await expect(rowOf(vault, toLock)).toHaveCount(1);
  await expect(rowOf(outside, toLock)).toHaveCount(0);
  await expect(vault.getByRole("heading")).toContainText("保险箱 · 2 条");

  // In a group with the owner, the Agent and one more member, an @ makes the Agent reply: its system text has the note that
  // stayed outside, and neither of the two in the vault.
  const title = await groupWithAgent(people, ann, bo, agent);
  await openChat(bo.page, title);
  await modelStub.reply(`在的。${tag}`);
  await sendText(bo.page, title, `@${agent.handle} 你好，在吗 ${tag}`);
  await expect(agentMessagesWith(chatInGroup(bo.page, title), `在的。${tag}`)).toHaveCount(1);
  const calls = await modelStub.waitForCalls(2);
  const given = aboutOwner(calls[1]);
  expect(given, "what the group reply was given of the owner").toContain(open);
  expect(given).not.toContain(toLock);
  expect(given).not.toContain(private_);
  const system = JSON.stringify(calls[1].body);
  expect(system).not.toContain("美式咖啡");
  expect(system).not.toContain(VAULT_MARK);
});

const chatInGroup = (page, title) => page.getByRole("region", { name: title, exact: true });

// --- C ------------------------------------------------------------------------------------------------------------------

test("C. 撤销 on the chip removes the note: the chip says 已撤销 and the palace no longer lists it", async ({ people }) => {
  const { ann, name, chat } = await annWithAgent(people);
  const tag = uniq(6);
  const note = `主人每天早上跑步 ${tag}`;
  await modelStub.memoryAnswer("review", tag, adds(note));
  await modelStub.reply(`好的。${tag}`);
  await sendText(ann.page, name, `我每天早上跑步 ${tag}`);

  const chip = chips(chat);
  await expect(chip).toHaveCount(1, { timeout: 40_000 });
  const room = await openPalace(ann.page);
  await expect(rowOf(room, note)).toHaveCount(1);

  // Back in the conversation, the chip opens to its line and 撤销.
  await openChat(ann.page, name);
  await chips(chat).click();
  const detail = chat.locator(".memory-detail");
  await expect(detail).toContainText(`记住了：${note}`);
  await detail.getByRole("button", { name: "撤销" }).click();
  await expect(detail).toContainText("已撤销");
  await expect(detail.getByRole("button", { name: "撤销" })).toHaveCount(0);

  const again = await openPalace(ann.page);
  await expect(again).toContainText("还没有记下的内容");
  await expect(rowOf(again, note)).toHaveCount(0);
});

// --- D ------------------------------------------------------------------------------------------------------------------

test("D. hearsay: a member's remark about the owner reaches the owner's conversation as 听说 and the Agent's page; the member sees and receives nothing of it", async ({ people }) => {
  const ann = await people.member("Ann");
  // Bo's browser is watched from its first request.
  const bo = await people.member("Bo", { open: false });
  await befriend(ann, bo);
  const traffic = recordTraffic(bo.context);
  bo.page = await people.openApp(bo);

  const name = `小记${uniq(4)}`;
  await createAgentUi(ann.page, { name, intro: "帮我记事", persona: "你是一个爱记事的助手。" });
  const { agents } = await (await ann.request.get("/api/agents")).json();
  const agent = agents.find((a) => a.name === name);
  expect(agent, "the Agent Ann created").toBeDefined();
  const title = await groupWithAgent(people, ann, bo, agent);
  await openChat(ann.page, title);
  const boGroup = await openChat(bo.page, title);

  // Bo says something about Ann, without an @; the judgement hears it as something said about its owner.
  const tag = uniq(6);
  const heard = `主人下周要交年度${LISTEN_MARK} ${tag}`;
  await modelStub.memoryAnswer("hearsay", tag, JSON.stringify({ entries: [{ from: "m1", text: heard }], drop: [] }));
  const said = `${ann.displayName}下周要交年度${LISTEN_MARK}，大家别打扰她 ${tag}`;
  expect(said).not.toContain("@");
  await sendText(bo.page, title, said);
  await judgeStub.judged(said);

  // After the quiet wait, Ann's own conversation with the Agent has a chip; opened, a line that begins 听说：.
  const annChat = await openChat(ann.page, name);
  const chip = chips(annChat);
  await expect(chip).toHaveCount(1, { timeout: 40_000 });
  await expect(chip).toContainText(name);
  await chip.click();
  const line = annChat.locator(".memory-detail .memory-lines li");
  await expect(line).toHaveCount(1);
  await expect(line).toContainText("听说：");
  await expect(line).toContainText(heard);
  await expect(line).toContainText(bo.displayName);
  expect(await callsAbout("hearsay", tag), "one hearsay call").toHaveLength(1);
  expect(await modelStub.calls(), "no reply was asked of the model").toHaveLength(0);

  // The Agent's page: 听说的, the line with Bo's name.
  const detail = await openAgentDetail(ann.page, name);
  await detail.getByRole("tab", { name: "记忆宫殿" }).click();
  const room = detail.getByRole("region", { name: `${name}听说的`, exact: true });
  await expect(room).toBeVisible();
  await expect(room.locator("li.memory-row")).toHaveCount(1);
  await expect(room.locator("li.memory-row")).toContainText(bo.displayName);
  await expect(room.locator("li.memory-row")).toContainText(heard);

  // Bo's pages: no chip anywhere, no conversation with the Agent; nothing Bo's browser received speaks of it.
  await bo.page.reload();
  const boAgain = await openChat(bo.page, title);
  await expect(bo.page.locator(".memory-chip")).toHaveCount(0);
  await expect(messageList(boAgain).locator("li.msg-memory")).toHaveCount(0);
  await expect(listRow(bo.page, name), "Bo has no conversation with Ann's Agent").toHaveCount(0);
  await expect(boGroup).not.toContainText("听说：");
  for (const frame of traffic.frames) {
    expect(frame.includes("memory_changed"), frame.slice(0, 200)).toBe(false);
    expect(frame.includes(heard), frame.slice(0, 200)).toBe(false);
  }
  for (const body of await traffic.api()) {
    expect(body.includes("memory_changed"), body.slice(0, 200)).toBe(false);
    expect(body.includes(heard), body.slice(0, 200)).toBe(false);
  }
});
