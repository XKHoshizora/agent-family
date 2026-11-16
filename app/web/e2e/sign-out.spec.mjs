// Signing out in one tab ends the session everywhere: the other tab's socket is closed with 4001 and that tab
// lands on the sign-in screen once, by itself. Also: a signed-out tab's API calls are refused.
import { test, expect } from "./support/fixtures.mjs";
import { signOutUi } from "./support/app.mjs";

/** Records every WebSocket close code of the page in `window.__wsCloseCodes`. */
function recordSocketCloses() {
  const Native = window.WebSocket;
  window.__wsCloseCodes = [];
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("close", (e) => window.__wsCloseCodes.push(e.code));
    }
  };
}

test("sign-out in one tab ends the other tab's session (socket 4001) and it lands on sign-in once", async ({ people }) => {
  // PRODUCT BUG (reported in task-10-report.md): the client signs out with `POST /api/auth/sign-out` and no
  // body; the service answers 400 invalid_request (README: "Body: none or {}"), so 退出登录 does nothing but
  // a toast. With a `{}` body the same request is 200. Remove this line once sign-out works from the UI.
  test.fail(true, "sign-out without a body is refused with 400 (product bug)");

  const ann = await people.member("Ann", { open: false });
  await ann.context.addInitScript(recordSocketCloses);
  const first = await people.openApp(ann);
  const second = await people.openApp(ann);
  const landings = [];
  second.on("framenavigated", (frame) => {
    if (frame === second.mainFrame() && new URL(frame.url()).pathname === "/signin") landings.push(frame.url());
  });

  await signOutUi(first);

  await expect(second.getByRole("heading", { name: "登录 Agent Family" })).toHaveCount(1);
  await expect(second).toHaveURL(/\/signin$/);
  await expect.poll(() => second.evaluate(() => window.__wsCloseCodes)).toContain(4001);
  expect(landings, "the second tab went to /signin exactly once").toHaveLength(1);
  expect((await ann.request.get("/api/me")).status(), "the session is over").toBe(401);
});
