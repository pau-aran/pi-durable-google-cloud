// STUB of the page's start (p2's apps/p2/src/hosts/web/main.tsx). CONTRACT: `/s/<session id>` is the chat, every
// other path the landing page.
import { createRoot } from "react-dom/client";
import { SESSION_ID_PATTERN } from "../protocol.ts";
import { ChatPage } from "./ChatPage.tsx";
import { Home } from "./Home.tsx";
import "./elanor.css";
import "./style.css";

const sessionId = location.pathname.match(/^\/s\/([^/]+)$/)?.[1];
document.documentElement.dataset.theme = document.documentElement.dataset.colorScheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
createRoot(document.getElementById("root")!).render(
  <div className="app">
    <main className="main">{sessionId && SESSION_ID_PATTERN.test(sessionId) ? <ChatPage sessionId={sessionId} /> : <Home />}</main>
  </div>,
);
