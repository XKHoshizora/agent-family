// The signed-in application is a lazy chunk (src/App.jsx). Tests that render <App> load it up front, so it is
// ready the moment React asks for it and fake timers never wait on a module being read from disk.
if (typeof document !== "undefined") await import("../src/AppShell.jsx");
