// STUB of the landing page (p2's `NewSession` in apps/p2/plugins/chat/web.tsx). CONTRACT: no props.
import { TopBar } from "./TopBar.tsx";

/** Creates a session with `POST /api/sessions` and opens `/s/<sessionId>`. */
export function Home() {
  const create = async () => {
    const response = await fetch("/api/sessions", { method: "POST" });
    const { sessionId } = (await response.json()) as { sessionId: string };
    location.assign(`/s/${sessionId}`);
  };
  return (
    <>
      <TopBar />
      <div className="hero">
        <button type="button" className="button" onClick={() => void create()}>
          New chat
        </button>
      </div>
    </>
  );
}
