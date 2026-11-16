import { describe, expect, it } from "vitest";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

// Invisible and reordering characters in what others see: group titles, messages and captions (and search over them).

const { blobs } = useProbeBlobs("af-invisible-");
const { app } = useApp({ blobs });

const INVALID = { status: 400, json: { error: "invalid_request" } };

async function three(): Promise<[Actor, Actor, Actor]> {
  return [await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
}

let txn = 0;
const send = (who: Actor, conv: string, body: Record<string, unknown>) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { clientTxn: `t${++txn}`, ...body });

describe("group titles follow the display-name rule (1-60)", () => {
  it("a title with nothing visible is refused, on creation and on renaming", async () => {
    const [a, b, c] = await three();
    await befriend(app, a, b);
    await befriend(app, a, c);
    const g = await group(app, a, "team", [b, c]);
    for (const title of ["\u200B", "\u200B\u2060\uFEFF", "\u202E", "\u200D\u200C", " \u00AD ", "\u{E0067}\u{E007F}"]) {
      const created = await api(app, a, "POST", "/api/conversations", { title, memberIds: [b.id, c.id] });
      expect([JSON.stringify(title), created]).toEqual([JSON.stringify(title), INVALID]);
      const renamed = await api(app, a, "PATCH", `/api/conversations/${g}`, { title });
      expect([JSON.stringify(title), renamed]).toEqual([JSON.stringify(title), INVALID]);
    }
  });

  it("format characters are removed (joiners and tag characters stay) and the length is counted without them", async () => {
    const [a, b, c] = await three();
    await befriend(app, a, b);
    await befriend(app, a, c);
    const created = await api(app, a, "POST", "/api/conversations", { title: " \u200Bsafe\u202Eelif.exe ", memberIds: [b.id, c.id] });
    expect(created.status).toBe(201);
    const g = created.json.id;
    expect((await api(app, b, "GET", `/api/conversations/${g}`)).json.title).toBe("safeelif.exe");
    const notice = (await api(app, b, "GET", `/api/conversations/${g}/messages`)).json.messages[0];
    expect(notice.system).toMatchObject({ event: "group_created", title: "safeelif.exe" });

    expect(await api(app, a, "PATCH", `/api/conversations/${g}`, { title: "safe\u2066evil\u2069 \u{1F469}\u200D\u{1F4BB}" })).toEqual({
      status: 200,
      json: { id: g, title: "safeevil \u{1F469}\u200D\u{1F4BB}" },
    });
    expect((await api(app, c, "GET", `/api/conversations/${g}`)).json.title).toBe("safeevil \u{1F469}\u200D\u{1F4BB}");
    // 60 visible characters plus invisible ones fit; 61 do not.
    expect((await api(app, a, "PATCH", `/api/conversations/${g}`, { title: `${"字".repeat(60)}\u200B\u202E` })).json.title).toBe("字".repeat(60));
    expect(await api(app, a, "PATCH", `/api/conversations/${g}`, { title: "字".repeat(61) })).toEqual(INVALID);
  });
});

/**
 * Characters that show nothing on their own but are not format characters: Hangul fillers, the Braille blank,
 * variation selectors without a base, the combining grapheme joiner, Khmer inherent vowels, Mongolian selectors.
 */
const BLANKS = ["\u3164", "\u115F", "\u1160", "\uFFA0", "\u2800", "\uFE0F", "\u{E0100}", "\u034F", "\u17B5", "\u180B", "\u3164\u2800 \uFE0F"];
/** Emoji and right-to-left text that must keep working everywhere a visible character is required. */
const LIVELY = [
  "\u{1F469}\u200D\u{1F4BB}", // ZWJ sequence
  "1\uFE0F\u20E3", // keycap
  "\u{1F1EF}\u{1F1F5}", // flag (regional indicators)
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // subdivision flag (tag characters)
  "\u{1F44D}\u{1F3FD}", // skin tone
  "\u2764\uFE0F", // variation selector after its base
  "\u05E9\u05DC\u05D5\u05DD", // Hebrew
  "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645", // Persian with ZWNJ
];

describe("nothing visible also means: no characters that show nothing (not only format characters)", () => {
  it("such a title or display name is refused; emoji and right-to-left names are not", async () => {
    const [a, b, c] = await three();
    await befriend(app, a, b);
    await befriend(app, a, c);
    const g = await group(app, a, "team", [b, c]);
    for (const title of BLANKS) {
      const label = JSON.stringify(title);
      expect([label, await api(app, a, "POST", "/api/conversations", { title, memberIds: [b.id, c.id] })]).toEqual([label, INVALID]);
      expect([label, await api(app, a, "PATCH", `/api/conversations/${g}`, { title })]).toEqual([label, INVALID]);
      expect([label, await api(app, a, "PATCH", "/api/me", { displayName: title })]).toEqual([label, INVALID]);
    }
    for (const title of LIVELY) {
      const label = JSON.stringify(title);
      expect([label, await api(app, a, "PATCH", `/api/conversations/${g}`, { title })]).toEqual([label, { status: 200, json: { id: g, title } }]);
      expect([label, (await api(app, a, "PATCH", "/api/me", { displayName: title })).status]).toEqual([label, 200]);
    }
  });
});

describe("message text and captions", () => {
  async function pair(): Promise<{ a: Actor; b: Actor; dm: string }> {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")];
    const { conversationId: dm } = await befriend(app, a, b);
    return { a, b, dm };
  }

  it("a text message needs a character that is neither white space nor a format character", async () => {
    const { a, dm } = await pair();
    for (const text of ["\u200B\u2060\uFEFF", " \u200B \n\u00AD", "\u202E\u2066", "\u200D"]) {
      expect([JSON.stringify(text), await send(a, dm, { text })]).toEqual([JSON.stringify(text), INVALID]);
    }
    expect(await api(app, a, "GET", `/api/conversations/${dm}/messages`).then((r) => r.json.messages.filter((m: { kind: string }) => m.kind === "text"))).toEqual([]);
  });

  it("nor of characters that show nothing; emoji and right-to-left text still go through as sent", async () => {
    const { a, dm } = await pair();
    for (const text of BLANKS) {
      expect([JSON.stringify(text), await send(a, dm, { text })]).toEqual([JSON.stringify(text), INVALID]);
    }
    for (const text of [...LIVELY, "\u05E9\u05DC\u05D5\u05DD\u200F!"]) {
      const sent = await send(a, dm, { text });
      expect([JSON.stringify(text), sent.status, sent.json.message?.text]).toEqual([JSON.stringify(text), 201, text]);
    }
  });

  it("control characters other than tab, line feed and carriage return are refused, in text and in captions", async () => {
    const { a, dm } = await pair();
    for (const text of ["\u0007", "\u001F", "\u0085", "a\u0007b", "x\u000By", "page\u000Cbreak", "a\u007Fb"]) {
      expect([JSON.stringify(text), await send(a, dm, { text })]).toEqual([JSON.stringify(text), INVALID]);
    }
    const kept = "col\tumn\r\nnext line";
    expect((await send(a, dm, { text: kept })).json.message.text).toBe(kept);
    const upload = await app.inject({
      method: "POST",
      url: `/api/conversations/${dm}/attachments`,
      headers: { cookie: a.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]),
    });
    expect(await send(a, dm, { attachmentId: JSON.parse(upload.body).id, text: "cap\u0007tion" })).toEqual(INVALID);
  });

  it("is stored as sent except for bidi overrides and isolates, which are removed", async () => {
    const { a, b, dm } = await pair();
    const sent = await send(a, dm, { text: " safe\u202Eelif.exe \u2066x\u2069 \u202A\u202B\u202C\u202D\u2067\u2068 " });
    expect(sent.status).toBe(201);
    expect(sent.json.message.text).toBe("safeelif.exe x");
    // Joiners, zero-width spaces and line breaks are left as they are.
    const kept = "\u{1F469}\u200D\u{1F4BB} a\u200Bb\nc";
    expect((await send(a, dm, { text: kept })).json.message.text).toBe(kept);
    const seen = (await api(app, b, "GET", `/api/conversations/${dm}/messages`)).json.messages.map((m: { text: string }) => m.text);
    expect(seen).toEqual(expect.arrayContaining(["safeelif.exe x", kept]));
  });

  it("the 8000-character limit stays, counted without the removed controls", async () => {
    const { a, dm } = await pair();
    expect((await send(a, dm, { text: `${"字".repeat(8000)}\u202E` })).status).toBe(201);
    expect(await send(a, dm, { text: "字".repeat(8001) })).toEqual(INVALID);
  });

  it("a caption loses its bidi controls and may be empty or invisible", async () => {
    const { a, dm } = await pair();
    const upload = async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/conversations/${dm}/attachments`,
        headers: { cookie: a.cookie, "content-type": MULTIPART },
        payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "hello" }]),
      });
      expect(res.statusCode).toBe(201);
      return JSON.parse(res.body).id as string;
    };
    expect((await send(a, dm, { attachmentId: await upload(), text: "see\u202E this" })).json.message.text).toBe("see this");
    expect((await send(a, dm, { attachmentId: await upload(), text: "\u200B" })).json.message.text).toBe("\u200B");
    expect((await send(a, dm, { attachmentId: await upload(), text: "\u202E" })).json.message.text).toBe("");
  });

  it("search finds the stored text, also when the term carries the removed controls", async () => {
    const { a, b, dm } = await pair();
    expect((await send(a, dm, { text: "report safe\u202Eelif.exe now" })).status).toBe(201);
    for (const q of ["safeelif", "safe\u202Eelif", "\u2066safeelif\u2069"]) {
      const inConversation = await api(app, b, "GET", `/api/conversations/${dm}/search?q=${encodeURIComponent(q)}`);
      const everywhere = await api(app, b, "GET", `/api/search?q=${encodeURIComponent(q)}`);
      for (const res of [inConversation, everywhere]) {
        expect([JSON.stringify(q), res.status, res.json.messages.map((m: { text: string }) => m.text)]).toEqual([
          JSON.stringify(q),
          200,
          ["report safeelif.exe now"],
        ]);
      }
    }
    // A term of nothing but such controls is no term.
    expect(await api(app, b, "GET", `/api/search?q=${encodeURIComponent("\u202E\u2066")}`)).toEqual(INVALID);
  });
});
