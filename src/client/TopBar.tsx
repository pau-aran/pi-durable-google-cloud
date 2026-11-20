// STUB of the top bar (p2's `TopBar` in apps/p2/plugins/chat/web.tsx). CONTRACT: the props.
/** The bar above the chat and the landing page. `offline`: the socket is down. */
export function TopBar({ title, offline = false }: { title?: string; offline?: boolean }) {
  return (
    <header className="topbar">
      <div className="title">
        <h1>{title}</h1>
      </div>
      {offline && <span className="offline">Offline</span>}
    </header>
  );
}
