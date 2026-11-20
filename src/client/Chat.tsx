// Adapted from p2 (apps/p2/src/web/Chat.tsx).
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TranscriptItem } from "@earendil-works/pi-durable";
import { memo, useMemo, useRef } from "react";
import { ActivityRow } from "./activity/ActivityRow.tsx";
import { type ChatItem, chatItems } from "./activity/model.ts";
import { CopyButton } from "./Code.tsx";
import { Markdown } from "./Markdown.tsx";
import { Time } from "./Time.tsx";
import type { Item, Transcript } from "./transcript.ts";
import "./transcript.css";

/** A gap's row, styled as the transcript's top edge. Load a page when its button is pressed. */
function GapRow({ item, onFillGap }: { item: Extract<ChatItem, { type: "gap" }>; onFillGap: (gap: Gap) => void }) {
  const { gap, loading } = item;
  return (
    <button
      type="button"
      className={`history-edge earlier${loading ? " loading" : ""}`}
      disabled={loading}
      aria-busy={loading}
      onClick={() => onFillGap(gap)}
    >
      <span className="spinner" aria-hidden="true" />
      Load more
    </button>
  );
}

/** The user's message as a bubble, with its time and Copy below. */
function UserMessage({ item }: { item: Extract<ChatItem, { type: "user" }> }) {
  const text = item.text.trim();
  return (
    <div className="user" data-entry={item.entryId}>
      <div className="user-line">
        <div className="bubble">{item.text}</div>
      </div>
      {/* Sent messages only: a queued one has neither its entry nor its time yet. */}
      {item.entryId !== undefined && (text || item.at !== undefined) && (
        <div className="message-actions">
          {item.at !== undefined && <Time at={item.at} className="message-time" />}
          {text && <CopyButton text={text} />}
        </div>
      )}
    </div>
  );
}

/** The notice below a response when it ends with an error, a stop or the length limit. */
function answerNotice(message: AssistantMessage): string | undefined {
  switch (message.stopReason) {
    case "aborted": return "Stopped";
    case "length": return "The response hit the model's length limit";
    case "error": return message.errorMessage || "The provider returned an error.";
  }
}

/** The agent's answer: the last text of its turn, with Copy and its time once complete. */
const Answer = memo(function Answer({ text, message, entryId, streaming }: Omit<Extract<ChatItem, { type: "answer" }>, "type" | "key">) {
  const trimmed = text.trim();
  const notice = streaming ? undefined : answerNotice(message);
  if (!trimmed && !notice) return null;
  return (
    <div className="assistant" data-entry={entryId}>
      {trimmed && (
        <div className={streaming ? "streaming" : undefined}>
          <Markdown text={text} />
          {!streaming && (
            <div className="message-actions">
              <CopyButton text={trimmed} />
              <Time at={message.timestamp} className="message-time" />
            </div>
          )}
        </div>
      )}
      {notice && <div className={`notice ${message.stopReason === "aborted" ? "stopped" : "error"}`}>{notice}</div>}
    </div>
  );
});

// Items keep their identity while unchanged (transcript.ts), so memoized rows skip updates to the live message.
const ItemView = memo(function ItemView({ item }: { item: Exclude<ChatItem, { type: "gap" }> }) {
  switch (item.type) {
    case "user":
      return <UserMessage item={item} />;
    case "text":
      return <div className="assistant" data-entry={item.entryId}><Markdown text={item.text} /></div>;
    case "activity":
      return (
        <ActivityRow
          steps={item.steps}
          entries={item.entries}
          working={item.working}
          startedAt={item.startedAt}
          endedAt={item.endedAt}
        />
      );
    case "answer":
      return <Answer text={item.text} entryId={item.entryId} message={item.message} streaming={item.streaming} />;
    case "failure":
      return <output className="notice error">{item.text}</output>;
    case "marker":
      return item.detail ? (
        <details className="marker">
          <summary>{item.label}</summary>
          <Markdown text={item.detail} />
        </details>
      ) : <div className="marker">{item.label}</div>;
  }
});

type Gap = Extract<TranscriptItem, { kind: "gap" }>;

/** A transcript row: a chat item and its spacing to the row before it. */
type TranscriptRow = {
  item: ChatItem;
  first: boolean;
  /** Parts of the same turn follow each other closely. */
  gap?: "step";
  /** The first part of the agent's turn is at least as tall as the working wheel it replaces. */
  lead?: boolean;
};

/** The parts of the agent's turn, which follow each other at the step distance. */
const TURN_PARTS: ReadonlySet<ChatItem["type"]> = new Set(["text", "activity", "answer"]);

function transcriptRows(items: readonly Item[], working: boolean): TranscriptRow[] {
  const shown = chatItems(items, working);
  return shown.map((item, index) => {
    const before = shown[index - 1];
    const part = TURN_PARTS.has(item.type);
    const step = part && before && TURN_PARTS.has(before.type);
    return { item, first: index === 0, gap: step ? "step" : undefined, lead: part && !step };
  });
}

/** Rows arriving together fade in one after another, this far apart, all within `ENTER_LAST`. */
const ENTER_STAGGER = 45;
const ENTER_LAST = 360;
/** How long a row counts as arriving (its animation's length and delay). */
const ENTER_FOR = 1_000;

/**
 * Rows appended after the previous last row fade in one after another, not the first rows of a fresh conversation,
 * older history above, or a row replaced in place (a streaming answer committed).
 */
function useArriving(rows: readonly TranscriptRow[]): ReadonlyMap<string, number> {
  const state = useRef<{ rows: readonly TranscriptRow[]; arriving: Map<string, { delay: number; until: number }> }>(undefined);
  const now = performance.now();
  const current = state.current;
  if (!current) {
    state.current = { rows, arriving: new Map() };
    return new Map();
  }
  if (current.rows !== rows) {
    const last = current.rows.at(-1);
    if (last && rows.length > current.rows.length) {
      const at = rows.findLastIndex(({ item }) => item.key === last.item.key);
      const added = at >= 0 ? rows.slice(at + 1) : [];
      added.forEach(({ item }, index) => {
        if (current.arriving.has(item.key)) return;
        const delay = Math.min(index * ENTER_STAGGER, ENTER_LAST);
        current.arriving.set(item.key, { delay, until: now + delay + ENTER_FOR });
      });
    }
    current.rows = rows;
  }
  const delays = new Map<string, number>();
  for (const [key, { delay, until }] of current.arriving) {
    if (until < now) current.arriving.delete(key);
    else delays.set(key, delay);
  }
  return delays;
}

/** The transcript: its rows, the edge of the loaded history above them, and the run's notices below. */
export const Messages = memo(function Messages({ transcript, earlier, onEarlier, onFillGap }: {
  transcript: Transcript;
  /** Older history exists ("more"), is being fetched ("loading"), or the transcript starts here ("start"). */
  earlier: "more" | "loading" | "start";
  onEarlier: () => void;
  /** Load the next page of a gap's entries. */
  onFillGap: (gap: Gap) => void;
}) {
  const rows = useMemo(() => transcriptRows(transcript.items, transcript.working), [transcript.items, transcript.working]);
  const arriving = useArriving(rows);
  return (
    <div className="messages">
      {/* One height in every state: the edge changing never moves the transcript under the reader. */}
      {earlier === "start" ? (
        <div className="history-edge">Start of conversation</div>
      ) : (
        <button
          type="button"
          className={`history-edge earlier${earlier === "loading" ? " loading" : ""}`}
          disabled={earlier === "loading"}
          aria-busy={earlier === "loading"}
          onClick={onEarlier}
        >
          <span className="spinner" aria-hidden="true" />
          Earlier messages
        </button>
      )}
      <div className="rows" data-rows={rows.length}>
        {rows.map(({ item, first, gap, lead }) => {
          const delay = arriving.get(item.key);
          return (
            <div
              key={item.key}
              className={`row${first ? " first" : ""}${delay === undefined ? "" : " arriving"}`}
              style={delay ? { animationDelay: `${delay}ms` } : undefined}
              data-row={item.key}
              data-gap={gap}
              data-lead={lead ? "" : undefined}
            >
              {item.type === "gap" ? <GapRow item={item} onFillGap={onFillGap} /> : <ItemView item={item} />}
            </div>
          );
        })}
      </div>
      {transcript.compactions.map((compaction) => (
        <output key={compaction.id} className="notice">
          {compaction.blocking ? "Compacting context…" : "Compacting context in background…"}
          {compaction.retry && ` Retrying: ${compaction.retry.error.slice(0, 200)}`}
        </output>
      ))}
      {transcript.retry && (
        <div className="notice">Provider error, retrying… {transcript.retry.error.slice(0, 200)}</div>
      )}
    </div>
  );
});
