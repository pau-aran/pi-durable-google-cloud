// STUB of the chat page (p2's `SessionChat`, `Dock` and `Composer` in apps/p2/plugins/chat/web.tsx). CONTRACT: the props.
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ServerMessage } from "../protocol.ts";
import { Messages } from "./Chat.tsx";
import { ChatState } from "./state.ts";
import { TopBar } from "./TopBar.tsx";
import { buildTranscript } from "./transcript.ts";

/** One session: its socket, its transcript, and its composer. */
export function ChatPage({ sessionId }: { sessionId: string }) {
  const [socket, setSocket] = useState<WebSocket>();
  const [state] = useState(() => new ChatState());
  const snapshot = useSyncExternalStore(state.subscribe, () => state.snapshot);
  useEffect(() => {
    const next = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${sessionId}`);
    next.onmessage = (event) => state.receive(JSON.parse(event.data as string) as ServerMessage);
    setSocket(next);
    return () => next.close();
  }, [sessionId, state]);
  return (
    <>
      <TopBar title="Chat" />
      <div className="chat">
        <div className="scroller transcript">
          {snapshot.shown && (
            <Messages
              transcript={buildTranscript(snapshot.shown, snapshot.filling)}
              earlier={snapshot.earlier ?? "start"}
              onEarlier={() => void state.loadEarlier()}
              onFillGap={(gap) => void state.fillGap(gap)}
            />
          )}
        </div>
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            const input = event.currentTarget.elements.namedItem("draft") as HTMLInputElement;
            const message = state.prompt(input.value, crypto.randomUUID());
            if (message) socket?.send(JSON.stringify(message));
            input.value = "";
          }}
        >
          <input name="draft" placeholder="Message Pi…" />
        </form>
      </div>
    </>
  );
}
