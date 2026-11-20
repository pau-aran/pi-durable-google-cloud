// Adapted from p2 (apps/p2/src/hosts/web/main.tsx, src/web/AppLayout.tsx and src/web/app-boundary.tsx): the page's
// start. `/s/<session id>` is the chat, every other path the landing page.
// The stylesheets first: elanor.css declares the cascade layers' order before any component's CSS names a layer.
import "./elanor.css";
import "./style.css";
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { SESSION_ID_PATTERN } from "../protocol.ts";
import { ChatPage } from "./ChatPage.tsx";
import { Home } from "./Home.tsx";
import { startTheme } from "./theme.ts";

/** The app's root boundary: a failure anywhere shows itself with a way out, instead of an empty page. */
class AppBoundary extends Component<{ children: ReactNode }, { error?: unknown }> {
  override state: { error?: unknown } = {};

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error };
  }

  override render() {
    if (this.state.error === undefined) return this.props.children;
    const { error } = this.state;
    return (
      <div className="hero" role="alert">
        <h2>This page failed</h2>
        <p className="muted">{error instanceof Error ? error.message : String(error)}</p>
        <button type="button" className="button primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

const sessionId = location.pathname.match(/^\/s\/([^/]+)$/)?.[1];
const chat = sessionId !== undefined && SESSION_ID_PATTERN.test(sessionId);
startTheme();
createRoot(document.getElementById("root")!).render(
  <AppBoundary>
    <div className="app">
      <main className={chat ? "main" : "main new-session-view"}>
        {chat ? <ChatPage sessionId={sessionId} /> : <Home />}
      </main>
    </div>
  </AppBoundary>,
);
