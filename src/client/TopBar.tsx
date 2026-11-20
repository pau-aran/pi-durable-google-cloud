// Adapted from p2 (`TopBar` in apps/p2/plugins/chat/web.tsx).
import { PlusIcon } from "./icons.tsx";
import { ThemeButton } from "./ThemeButton.tsx";

/**
 * The bar above the chat and the landing page. `offline`: the socket is down. Without a `title` it is the landing
 * page's bar, which has no heading and no link to itself.
 */
export function TopBar({ title, offline = false }: { title?: string; offline?: boolean }) {
  return (
    <header className="topbar">
      {title !== undefined && (
        <a className="icon-button" href="/" aria-label="New session" title="New session">
          <PlusIcon />
        </a>
      )}
      <div className="title">{title !== undefined && <h1>{title}</h1>}</div>
      {offline && <span className="offline">Offline</span>}
      <ThemeButton />
    </header>
  );
}
