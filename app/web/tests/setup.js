// The signed-in application is a lazy chunk (src/App.jsx). Tests that render <App> load it up front, so it is
// ready the moment React asks for it and fake timers never wait on a module being read from disk.
if (typeof document !== "undefined") await import("../src/AppShell.jsx");

// An Agent's text turns rich at an animation frame (src/ui/markdownView.jsx `inFrame`). In tests a frame is the next
// microtask, so a text is rich as soon as its answer has arrived and nothing waits on a clock; the tests of the frames
// themselves (tests/markdown-view.test.jsx) turn a clock of their own by hand.
if (typeof document !== "undefined") {
  const { setFrameClock } = await import("../src/ui/markdownView.jsx");
  setFrameClock((run) => queueMicrotask(run));
}
