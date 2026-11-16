import React from "react";
import { Btn } from "./primitives.jsx";

const CHUNK_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;
/** The rejected dynamic import of a chunk that is gone (as against any other error while rendering). */
export const isChunkLoadError = (error) => error?.name === "ChunkLoadError" || CHUNK_FAILURE.test(String(error?.message ?? ""));

/**
 * Catches an error under the lazy application chunk instead of leaving a blank page: a failed chunk load (a stale tab
 * after a deploy) says the page was updated, any other error says something went wrong; both offer a reload.
 */
export class ChunkBoundary extends React.Component {
  state = { failed: false, stale: false };

  static getDerivedStateFromError(error) {
    return { failed: true, stale: isChunkLoadError(error) };
  }

  componentDidCatch(error) {
    console.error(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="auth-page">
        <p role="alert">{this.state.stale ? "页面已更新，请刷新" : "出了点问题，请刷新页面"}</p>
        <Btn variant="primary" onClick={() => (this.props.reload ?? (() => window.location.reload()))()}>刷新页面</Btn>
      </main>
    );
  }
}
