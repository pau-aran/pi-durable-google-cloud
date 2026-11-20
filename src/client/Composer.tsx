// Adapted from p2 (`Composer` and `keepComposerFocus` in apps/p2/plugins/chat/web.tsx).
import { useLayoutEffect, useRef, useState } from "react";
import { SendIcon } from "./icons.tsx";
import "./composer.css";

/**
 * The draft's textarea with Send. Enter (with a fine pointer) and a tap on Send do `onSend`, which says whether it took
 * the text: the draft is then empty. The draft is kept in the browser under `draftKey`, so a reload does not lose it.
 */
export function Composer({
  busy = false,
  disabled = false,
  draftKey,
  onSend,
}: {
  /** A run is active: what is sent now waits for it. */
  busy?: boolean;
  disabled?: boolean;
  draftKey: string;
  onSend: (text: string) => boolean | Promise<boolean>;
}) {
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? "");
  const input = useRef<HTMLTextAreaElement>(null);
  const content = draft.trim() !== "";
  const write = (text: string) => {
    setDraft(text);
    if (text) localStorage.setItem(draftKey, text);
    else localStorage.removeItem(draftKey);
  };
  const send = async () => {
    if (content && !disabled && (await onSend(draft.trim()))) write("");
  };
  // As tall as its text, up to the max-height of `.draft-editor`.
  useLayoutEffect(() => {
    const element = input.current!;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);
  return (
    <form
      className="composer"
      onPointerDown={keepComposerFocus}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={input}
        className="draft-editor"
        rows={1}
        autoFocus
        aria-label="Message"
        // This server queues an input sent during a run as a follow-up; it does not steer the run.
        placeholder={busy ? "Queue a follow-up…" : "Message Pi…"}
        value={draft}
        onChange={(event) => write(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          if (!window.matchMedia("(pointer: fine)").matches) return;
          event.preventDefault();
          void send();
        }}
      />
      <div className="composer-bar">
        <span className="spacer" />
        <button type="submit" className="round send" aria-label="Send" title="Send" disabled={!content || disabled}>
          <SendIcon />
        </button>
      </div>
    </form>
  );
}

/**
 * Keeps the focus in the composer's textarea when anything in the composer but a text field is pressed: Send, and the
 * space around it. A press that blurs the textarea closes a phone's keyboard and the page grows back under the finger:
 * a thumb landing a few pixels beside Send (the composer's padding, the bar's gaps) only closed the keyboard, and the
 * second tap sent. The click still fires.
 */
function keepComposerFocus(event: React.PointerEvent<HTMLFormElement>): void {
  // Pointer events target elements, never text nodes.
  if ((event.target as Element).closest("textarea")) return;
  event.preventDefault();
}
