// Adapted from p2 (`NewSession` in apps/p2/plugins/chat/web.tsx).
import { useState } from "react";
import { unansweredKey } from "./ChatPage.tsx";
import { Composer } from "./Composer.tsx";
import { PiLogo } from "./PiLogo.tsx";
import { TopBar } from "./TopBar.tsx";

/** The landing page: the first message creates a session with `POST /api/sessions` and opens `/s/<sessionId>`. */
export function Home() {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const start = async (content: string): Promise<boolean> => {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`The server answered ${response.status}.`);
      const { sessionId } = (await response.json()) as { sessionId: string };
      // The chat page sends it (ChatPage.tsx); its request ID is made here, so a reload there sends the same prompt.
      sessionStorage.setItem(unansweredKey(sessionId), JSON.stringify([{ requestId: crypto.randomUUID(), content }]));
      location.assign(`/s/${sessionId}`);
      return true;
    } catch (error) {
      setCreating(false);
      setError(`The session could not be created: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  return (
    <>
      <TopBar />
      {error && (
        <button type="button" className="toast" onClick={() => setError(undefined)}>
          {error}
        </button>
      )}
      <div className="chat">
        <div className="scroller">
          <div className="hero">
            <div className="hero-title">
              <PiLogo />
              <h2>What should Pi do?</h2>
            </div>
          </div>
        </div>
        <div className="dock">
          <div className="composer-wrap">
            <Composer disabled={creating} draftKey="draft:new" onSend={start} />
          </div>
        </div>
      </div>
    </>
  );
}
