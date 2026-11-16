// Pure UI navigation and toast. Server-backed state is applied by the data layer (Task 2).
export function reducer(state, action) {
  switch (action.type) {
    case "nav":
      return { ...state, nav: { ...state.nav, ...action.patch } };
    case "nav/openConv":
      return {
        ...state,
        nav: {
          ...state.nav,
          section: "chat",
          convId: action.convId,
          view: "chat",
          pane: "main",
          // (A message to scroll to belongs to the conversation it was asked for.)
          focus: state.nav.focus?.convId === action.convId ? state.nav.focus : null,
          ...(action.patch || {}),
        },
      };
    case "toast":
      return { ...state, seq: state.seq + 1, toast: { id: state.seq + 1, text: action.text } };
    case "toast/clear":
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
    default:
      return state;
  }
}
