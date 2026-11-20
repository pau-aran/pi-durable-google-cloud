// Adapted from p2 (`SessionChat`, `Dock` and `Main` in apps/p2/plugins/chat/web.tsx, `useOffline` in
// apps/p2/src/runtime/web.tsx, and apps/p2/src/runtime/connection-state.ts).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ClientMessage, ServerMessage } from "../protocol.ts";
import { Messages } from "./Chat.tsx";
import { Composer } from "./Composer.tsx";
import { DownIcon } from "./icons.tsx";
import { browserEnvironment, keepConnected } from "./reconnect.ts";
import { ChatState } from "./state.ts";
import { TopBar } from "./TopBar.tsx";
import { buildTranscript, type Item, type Transcript } from "./transcript.ts";
import { useFollow } from "./use-follow.ts";

/**
 * How long the link may be closed before the page says "Offline". A page back from the background (Android froze it,
 * its socket is gone) reconnects within about a second; a label flashing for that says nothing. Past 2 s the wait is
 * one the person notices, so the label explains it. A device known to be offline says so at once.
 */
const OFFLINE_AFTER_MS = 2000;

function subscribeOnline(listener: () => void): () => void {
  addEventListener("online", listener);
  addEventListener("offline", listener);
  return () => {
    removeEventListener("online", listener);
    removeEventListener("offline", listener);
  };
}

/**
 * Whether the page should say it is offline: its link down longer than `OFFLINE_AFTER_MS`, or closed while the device
 * is known to be offline.
 */
function useOffline(connected: boolean): boolean {
  const [down, setDown] = useState(false);
  useEffect(() => {
    if (connected) return setDown(false);
    const timer = setTimeout(() => setDown(true), OFFLINE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);
  return down || (!connected && !online);
}

/**
 * Where a session's prompts without a `result` wait in `sessionStorage`, as `{ requestId, content }[]`: across a
 * reload, and a new session's first message across the navigation from the landing page. A prompt sent twice is stored
 * once, by its request ID.
 */
export const unansweredKey = (sessionId: string): string => `unanswered:${sessionId}`;

/** Before the server shows the conversation (a new session's first message), the messages sent from here show alone. */
const NOTHING_YET: Transcript = { items: [], busy: false, working: false, compactions: [], queued: [] };

/** One session: its socket, its transcript, and its composer. */
export function ChatPage({ sessionId }: { sessionId: string }) {
  // The socket whose first `view` arrived: the server reads from it.
  const ready = useRef<WebSocket>(undefined);
  const [connected, setConnected] = useState(false);
  const offline = useOffline(connected);
  const send = (message: ClientMessage): boolean => {
    ready.current?.send(JSON.stringify(message));
    return ready.current !== undefined;
  };
  const [state] = useState(() => {
    const state = new ChatState(send);
    const waiting = JSON.parse(sessionStorage.getItem(unansweredKey(sessionId)) ?? "[]") as { requestId: string; content: string }[];
    for (const { requestId, content } of waiting) state.prompt(content, requestId);
    return state;
  });
  const snapshot = useSyncExternalStore(state.subscribe, () => state.snapshot);

  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${sessionId}`;
    const connection = keepConnected({
      open: (events) => {
        const socket = new WebSocket(url);
        let ended = (_reason: string): void => {};
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data as string) as ServerMessage;
          state.receive(message);
          // The server reads prompts only once the session is attached, which its first `view` shows.
          if (message.type !== "view" || ready.current === socket) return;
          ready.current = socket;
          events.opened();
          for (const prompt of state.unanswered()) socket.send(JSON.stringify(prompt));
        };
        socket.onclose = (event) => {
          events.closed(event.code, event.reason, event.wasClean);
          ended("socket closed");
        };
        return {
          onClose: (handler) => {
            ended = handler;
          },
          close: (reason = "closed") => {
            socket.onmessage = null;
            socket.close();
            ended(reason);
          },
        };
      },
      onConnected: (value) => {
        if (!value) {
          ready.current = undefined;
          state.disconnected();
        }
        setConnected(value);
      },
      environment: browserEnvironment("chat"),
    });
    return () => connection.stop();
  }, [sessionId, state]);

  const transcript = useMemo(
    () => snapshot.shown && buildTranscript(snapshot.shown, snapshot.filling),
    [snapshot.shown, snapshot.filling],
  );
  const newestEntry = snapshot.shown?.items.findLast((item) => item.kind === "entry")?.entry.id ?? 0;
  const busy = transcript?.busy ?? false;
  // Prompts sent from here that the server does not show yet: shown as they will look, a person's message at the end,
  // or a queued input while a run is busy. The view with a prompt's entry or queued input arrives just before its
  // `result`, so a prompt is shown by the server once the view has an entry newer than any before it was sent, or
  // lists its text as queued.
  const sentAfter = useRef(new Map<string, number>()).current;
  // A new snapshot follows each change of the unanswered prompts.
  const unanswered = useMemo(() => state.unanswered(), [state, snapshot]);
  useEffect(() => {
    sessionStorage.setItem(unansweredKey(sessionId), JSON.stringify(unanswered));
    for (const id of sentAfter.keys()) if (!unanswered.some((prompt) => prompt.requestId === id)) sentAfter.delete(id);
  }, [sessionId, unanswered, sentAfter]);
  const pending = useMemo(
    () =>
      unanswered.filter(
        (prompt) =>
          newestEntry <= (sentAfter.get(prompt.requestId) ?? Infinity) &&
          !transcript?.queued.some((item) => item.text === prompt.content),
      ),
    [unanswered, sentAfter, newestEntry, transcript],
  );
  const shown = useMemo(() => {
    if (busy || !pending.length) return transcript;
    const messages = pending.map((prompt): Item => ({ type: "user", key: `outgoing-${prompt.requestId}`, text: prompt.content }));
    return { ...(transcript ?? NOTHING_YET), items: [...(transcript?.items ?? []), ...messages] };
  }, [transcript, pending, busy]);

  const follow = useFollow(shown, () => {
    if (state.snapshot.earlier === "more") void state.loadEarlier();
  });

  return (
    <>
      <TopBar title="Chat" offline={offline} />
      {snapshot.error && (
        <button type="button" className="toast" onClick={() => state.dismissError()}>
          {snapshot.error}
        </button>
      )}
      <div className="chat">
        <div className="scroller transcript" ref={follow.scroller}>
          {shown ? (
            shown.items.length ? (
              <Messages
                transcript={shown}
                earlier={snapshot.earlier ?? "start"}
                onEarlier={() => void state.loadEarlier()}
                onFillGap={(gap) => void state.fillGap(gap)}
              />
            ) : (
              <div className="hero small-hero">
                <p className="muted">Send a message to start.</p>
              </div>
            )
          ) : (
            <div className="hero">
              <div className="spinner large" />
            </div>
          )}
        </div>
        {/* The dock floats over the transcript's bottom. */}
        <div className="dock" ref={follow.dock}>
          <div className="composer-wrap">
            {!follow.atBottom && (
              <button type="button" className="to-bottom" onClick={follow.toBottom} aria-label="Scroll to bottom">
                <DownIcon />
              </button>
            )}
            {transcript && transcript.queued.length + (busy ? pending.length : 0) > 0 && (
              // This protocol cannot take an input back from the queue: a row is its label and text.
              <div className="queued">
                {transcript.queued.map((item) => (
                  <div key={item.id}>
                    <span className="queue-edit">
                      <span>Queued</span> {item.text}
                    </span>
                  </div>
                ))}
                {busy &&
                  pending.map((prompt) => (
                    <div key={`outgoing-${prompt.requestId}`}>
                      <span className="queue-edit">
                        <span>Queued</span> {prompt.content}
                      </span>
                    </div>
                  ))}
              </div>
            )}
            <Composer
              busy={busy}
              draftKey={`draft:${sessionId}`}
              onSend={(text) => {
                const requestId = crypto.randomUUID();
                const message = state.prompt(text, requestId);
                if (!message) return false;
                sentAfter.set(requestId, newestEntry);
                send(message);
                return true;
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
