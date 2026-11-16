// Who sees what in a group: someone added later sees nothing from before (not in history, not in a quote, not in
// either search); someone removed loses the open conversation at once, without a reload.
import { test, expect } from "./support/fixtures.mjs";
import { createGroupApi, sendApi, uniq } from "./support/accounts.mjs";
import {
  addMemberUi,
  chatPane,
  expectStored,
  hitFor,
  listRow,
  messageList,
  messagesWith,
  openChat,
  removeMemberUi,
  searchEverywhere,
  sendText,
  composer,
} from "./support/app.mjs";

test("a late joiner sees nothing from before, also not through a quote or a search", async ({ people }) => {
  const [ann, bo, di, cy] = await people.friendsOf(["Ann", "Bo", "Di", "Cy"]);
  const tag = uniq(4);
  const title = `读书会${tag}`;
  const groupId = await createGroupApi(ann, [bo, di], title);
  const early = `入群前的秘密${tag}，只有老成员知道`;
  await sendApi(bo, groupId, early);

  const annChat = await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  await expectStored(annChat, early);
  await addMemberUi(ann.page, title, cy.displayName);

  // Cy's page (open all along) gets the group; its first message is Cy's own join notice.
  const cyChat = await openChat(cy.page, title);
  await expect(messageList(cyChat).getByRole("listitem").first()).toContainText("邀请你加入了群聊");
  await expect(messagesWith(cyChat, early)).toHaveCount(0);

  // Ann replies to the early message: the old members see the quote, Cy only that it is out of view.
  const reply = `回复一下老消息 ${tag}`;
  await messagesWith(annChat, early).getByRole("button", { name: "回复" }).click();
  await composer(annChat).fill(reply);
  await composer(annChat).press("Enter");
  await expectStored(annChat, reply);
  await expectStored(boChat, reply);
  await expect(messagesWith(boChat, reply).locator("blockquote")).toContainText(early);
  await expectStored(cyChat, reply);
  await expect(messagesWith(cyChat, reply).locator("blockquote")).toHaveText("引用的消息不在你的可见范围内");
  await expect(cyChat).not.toContainText(`入群前的秘密${tag}`);

  // Neither search finds the early message for Cy; the global one finds the later one.
  await cyChat.getByRole("button", { name: "搜索本会话" }).click();
  await cyChat.getByRole("textbox", { name: "在本会话中搜索" }).fill(`入群前的秘密${tag}`);
  await expect(cyChat.getByText("没有找到相关消息，请换个关键词")).toBeVisible();
  await cyChat.getByRole("button", { name: "关闭会话搜索" }).click();
  await searchEverywhere(cy.page, `入群前的秘密${tag}`);
  await expect(cy.page.getByText("没有找到相关聊天记录")).toBeVisible();
  await searchEverywhere(cy.page, `回复一下老消息 ${tag}`);
  await expect(hitFor(cy.page, `回复一下老消息 ${tag}`)).toHaveCount(1);
  // Old members still find it.
  await searchEverywhere(di.page, `入群前的秘密${tag}`);
  await expect(hitFor(di.page, `入群前的秘密${tag}`)).toHaveCount(1);

  // A fresh load for Cy changes nothing.
  await cy.page.reload();
  const reloaded = await openChat(cy.page, title);
  await expectStored(reloaded, reply);
  await expect(reloaded).not.toContainText(`入群前的秘密${tag}`);
});

test("a removed member's open page drops the conversation at once", async ({ people }) => {
  const [ann, bo, di] = await people.friendsOf(["Ann", "Bo", "Di"]);
  const tag = uniq(4);
  const title = `周末徒步${tag}`;
  await createGroupApi(ann, [bo, di], title);
  const line = `周六早上八点集合${tag}`;
  await openChat(ann.page, title);
  const boChat = await openChat(bo.page, title);
  const diChat = await openChat(di.page, title);
  await sendText(ann.page, title, line);
  await expectStored(boChat, line);

  await removeMemberUi(ann.page, title, bo.displayName);
  await expect(bo.page.getByRole("status").filter({ hasText: "你已不在该会话中" })).toBeVisible();
  await expect(chatPane(bo.page, title)).toBeHidden();
  await expect(bo.page.getByText("选择一个会话开始聊天")).toBeVisible();
  await expect(listRow(bo.page, title)).toHaveCount(0);
  await expect(messageList(diChat).getByRole("listitem").last()).toContainText(`移出了群聊`);

  // Nothing of it in Bo's search; the members still find the line.
  await searchEverywhere(bo.page, `周六早上八点集合${tag}`);
  await expect(bo.page.getByText("没有找到相关聊天记录")).toBeVisible();
  await searchEverywhere(di.page, `周六早上八点集合${tag}`);
  await expect(hitFor(di.page, `周六早上八点集合${tag}`)).toHaveCount(1);
  await sendText(di.page, title, `Bo 走了 ${tag}`);
  await expect(listRow(bo.page, title)).toHaveCount(0);
});
