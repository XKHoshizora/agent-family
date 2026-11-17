// Links of the third review that forged or reversed the old "（实际指向 host）" note (rr3 links.mjs, its cases copied
// verbatim below this header). Each is rendered by tests/markdown-links.test.jsx: every link now shows its real host.
const long64 = "secure-session-0123456789abcdef0123456789abcdef0123456789abcdef0a"; // 65 chars
export const LINK_CASES = [
  ["cyrillic a in text, real latin target (expect note)", "[bаnk.example](https://bank.example/)"],
  ["latin text, cyrillic target (expect note)", "[bank.example](https://bаnk.example/)"],
  ["all-cyrillic homograph both sides", "[аррlе.com](https://аррlе.com/)"],
  ["autolink literal, cyrillic homograph", "https://аррlе.com/login"],
  ["fullwidth text", "[ｂａｎｋ．ｅｘａｍｐｌｅ](https://evil.example/)"],
  ["math bold text", "[𝐛𝐚𝐧𝐤.𝐞𝐱𝐚𝐦𝐩𝐥𝐞](https://evil.example/)"],
  ["one dot leader U+2024", "[bank\u2024example](https://evil.example/)"],
  ["small full stop U+FE52", "[bank\uFE52example](https://evil.example/)"],
  ["Lisu tone mya ti U+A4F8 as dot", "[bank\uA4F8example](https://evil.example/)"],
  ["Syriac supralinear full stop U+0701", "[bank\u0701example](https://evil.example/)"],
  ["Arabic-Indic zero U+0660 as dot", "[bank\u0660example](https://evil.example/)"],
  ["Canadian syllabics final middle dot U+1427", "[bank\u1427example](https://evil.example/)"],
  ["hyphenation point U+2027", "[bank\u2027example](https://evil.example/)"],
  ["middle dot U+00B7", "[bank\u00B7example](https://evil.example/)"],
  ["combining low line after TLD (under the link's underline)", "[bank.example\u0332](https://evil.example/)"],
  ["combining low line inside TLD", "[bank.exa\u0332mple](https://evil.example/)"],
  ["combining dot above U+0307 on the TLD's l", "[bank.exampl\u0307e](https://evil.example/)"],
  ["combining mark first in host (IDNA invalid)", "[\u0332bank.example](https://evil.example/)"],
  ["label over 63 characters before the trusted domain", `[${long64}.bank.example](https://evil.example/)`],
  ["long label with https:// and path", `[https://${long64}.bank.example/login](https://evil.example/)`],
  ["empty label", "[bank..example](https://evil.example/)"],
  ["ZWJ inside label", "[ba\u200Dnk.example](https://evil.example/)"],
  ["RLO reversed text", "[\u202Eelpmaxe.knab](https://evil.example/) 请点击"],
  ["RLO with trailing text (note reversed?)", "请访问 [\u202Ekn](https://evil.example/)"],
  ["ideographic full stop", "[bank。example](https://evil.example/)"],
  ["userinfo in text", "[https://bank.example@evil.example](https://evil.example/)"],
  ["percent-encoded dot", "[bank%2Eexample](https://evil.example/)"],
  ["trusted as subdomain of real", "[bank.example](https://bank.example.evil.example/)"],
  ["real as subdomain of trusted text", "[evil.example.bank.example](https://evil.example/)"],
  ["long subdomain chain in real host", "[bank.example](https://bank.example.secure-login.account-verify.session-0123456789.evil.example/)"],
  ["port in text same host", "[bank.example:8443](https://bank.example:8443/)"],
  ["host in text with trailing digit TLD", "[bank.example1](https://evil.example/)"],
  ["single-letter-ish TLD look", "[bank.co](https://evil.example/)"],
  ["text says IPv4, target other", "[10.0.0.1](https://evil.example/)"],
  ["text IPv4 with fullwidth digits", "[１０.０.０.１](https://10.0.0.2/)"],
  ["dotless trusted name", "[bank](https://evil.example/)"],
  ["host split across two links", "[bank.](https://evil.example/)[example](https://evil.example/)"],
  ["host split link + plain text", "[bank](https://evil.example/).example"],
  ["text in emphasis outside link", "**bank.example** [登录](https://evil.example/)"],
  ["image alt", "![bank.example](https://evil.example/a.png)"],
  ["footnote-ish label", "[bank.example][r]\n\n[r]: https://evil.example/"],
  ["very long real host for the note", `[x.example](https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.example/)`],
];

// The fourth review's forgeries (task-5-round3-review.md, Critical 1 (i)–(iii); rr4 links.mjs), verbatim: a link whose
// text showed a trusted address and no host note. Rendered by tests/markdown-links.test.jsx.
export const R4_LINK_CASES = [
  ["(i) a bidi override as a character reference", "[https://&#x202E;evil.example/moc.elgoog.stnuocca](https://evil.example/moc.elgoog.stnuocca)"],
  ["(i) the same, decimal", "[https://&#8238;evil.example/moc.elgoog](https://evil.example/moc.elgoog)"],
  ["(i) the override as the whole host text", "[&#x202E;moc.elgoog](https://evil.example/)"],
  [
    "(ii) hidden text inside maths, equal through the decoded address",
    "[$$\\rlap{\\phantom{\\text{https://evil.example/}}}\\text{https://google.com}$$](<https://evil.example/https://google.com%5Crlap%7B%5Cphantom%7B%5Ctext%7Bhttps://evil.example/%7D%7D%7D%5Ctext%7Bhttps://google.com%7Dhttps://evil.example/https://google.com>)",
  ],
  ["(iii) a line break splitting the visible host", "[https://accounts.google.com\n.evil.example/login](https://accounts.google.com.evil.example/login)"],
  ["(iii) 300 no-break spaces", "[https://accounts.google.com" + "\u00a0".repeat(300) + ".evil.example/](https://accounts.google.com.evil.example/)"],
  ["(iii) 300 em spaces", "[https://accounts.google.com" + "\u2003".repeat(300) + ".evil.example/](https://accounts.google.com.evil.example/)"],
  ["(iii) 30 hard breaks", "[https://accounts.google.com" + "\\\n".repeat(30) + ".evil.example/](https://accounts.google.com.evil.example/)"],
  ["a tab in the host", "[https://accounts.google.com\t.evil.example/](https://accounts.google.com.evil.example/)"],
  ["a percent-decoded address as the text", "[https://evil.example/google.com](https://evil.example/%67oogle.com)"],
  ["the host alone as the text", "[google.com](https://google.com/x)"],
  ["the host in capitals", "[GOOGLE.COM](https://google.com/x)"],
  ["www. before the host", "[www.evil.example](https://evil.example/a)"],
  ["a zero-width space in the host", "[goo\u200bgle.com](https://google.com/)"],
  ["full-width address", "[ｈｔｔｐｓ://ｅｖｉｌ.ｅｘａｍｐｌｅ](https://evil.example/)"],
];

// The fifth review (task-5-round4-review.md, Important 1), verbatim: links that are exactly their address, glued to a
// link, to plain text or to a code span before them, read as one trusted address when such links had no host note.
export const R5_LINK_CASES = [
  ["two exact links glued together", "https://accounts.google.com/signin?continue=<https://evil.example/>"],
  ["plain text directly in front of an exact link", "accounts.google.com/signin?continue=https://evil.example/"],
  ["a code span directly in front of an exact link", "`https://accounts.google.com/`https://evil.example/"],
];
