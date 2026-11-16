import React from "react";
import { Btn } from "./primitives.jsx";

/** Catches a failed load of the application chunk (a stale tab after a deploy) and asks for a reload instead of a blank page. */
export class ChunkBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="auth-page">
        <p role="alert">页面已更新，请刷新</p>
        <Btn variant="primary" onClick={() => (this.props.reload ?? (() => window.location.reload()))()}>刷新页面</Btn>
      </main>
    );
  }
}
