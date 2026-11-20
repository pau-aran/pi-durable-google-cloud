// Adapted from p2 (apps/p2/src/web/transcript.ts). CONTRACT: the exported types and the signature of `buildTranscript`
// are shared by the transcript, the activity, and the chat page. The body of `buildTranscript` is a stub.
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { LiveState, TranscriptItem, TranscriptView } from "@earendil-works/pi-durable";

export type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted";

/** One tool call, joined with its live slot and its result entry. */
export type ToolView = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  output: string;
  details?: JsonValue;
  /** The result's recorded execution time. */
  durationMs?: number;
  /** When the call started, in ms: its result's time less its duration; absent until it has a result. */
  at?: number;
};

type Gap = Extract<TranscriptItem, { kind: "gap" }>;

export type Item =
  | {
      type: "user";
      key: string;
      text: string;
      /** The entry this item shows. */
      entryId?: number;
      /** When it was sent (its model message's time), in ms. */
      at?: number;
    }
  | {
      type: "assistant";
      key: string;
      /** The committed entry; absent while streaming. */
      entryId?: number;
      message: AssistantMessage;
      tools: ToolView[];
      streaming: boolean;
    }
  | { type: "failure"; key: string; text: string }
  | { type: "marker"; key: string; label: string; detail?: string }
  | { type: "tool"; key: string; tool: ToolView }
  /** Entries between two loaded ones are missing (`ChatState.fillGap`); `loading` while they load. */
  | { type: "gap"; key: string; gap: Gap; loading: boolean };

export type Transcript = {
  items: Item[];
  /** A run is active (`pi.live.run`). */
  busy: boolean;
  /** A run or a compaction is active. */
  working: boolean;
  retry?: { at: number; error: string };
  compactions: { id: number; blocking: boolean; retry?: { at: number; error: string } }[];
  /** Inputs that wait for the running answer (`pi.inbox`). */
  queued: { id: number; mode: string; text: string }[];
};

/**
 * The display items of a conversation's transcript and the live state of the view's documents. `filling` names the
 * gaps being loaded (`gapKey` in state.ts).
 */
export function buildTranscript(view: TranscriptView, filling: ReadonlySet<string> = new Set()): Transcript {
  const live = view.docs["pi.live"] as unknown as LiveState | undefined;
  const items: Item[] = [];
  for (const item of view.items) {
    if (item.kind === "gap") items.push({ type: "gap", key: `gap-${item.after}`, gap: item, loading: filling.has(`gap-${item.after}`) });
    if (item.kind !== "entry") continue;
    const message = item.entry.model?.[0];
    const key = String(item.entry.id);
    if (message?.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      items.push({ type: "user", key, entryId: item.entry.id, at: message.timestamp, text });
    } else if (message?.role === "assistant") {
      items.push({ type: "assistant", key, entryId: item.entry.id, message, tools: [], streaming: false });
    }
  }
  const partial = live?.generation?.message as unknown as AssistantMessage | undefined;
  if (partial) items.push({ type: "assistant", key: "live", message: partial, tools: [], streaming: true });
  const busy = Boolean(live?.run);
  return { items, busy, working: busy, compactions: [], queued: [] };
}
