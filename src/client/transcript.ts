// Adapted from p2 (apps/p2/src/web/transcript.ts).
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  CompactionFailure,
  EntryRecord,
  InboxState,
  LiveState,
  RunFailure,
  ToolSlot,
  TranscriptItem,
  TranscriptView,
} from "@earendil-works/pi-durable";
import { gapKey } from "./state.ts";

/** The display status of a tool call, joined with its live slot and result entry. */
type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted";

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

/** A display item from a stored entry or live conversation state. */
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

/** Display items and the work still running or waiting in the conversation. */
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

function text(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function resultTool(result: ToolResultMessage): ToolView {
  return {
    id: result.toolCallId,
    name: result.toolName,
    args: {},
    status: result.isError ? "error" : "done",
    output: text(result.content),
    // SAFETY: Details came from a JSON frame; pi-ai types its arrays and object fields as readonly.
    details: result.details as JsonValue | undefined,
    ...(typeof result.durationMs === "number" ? { durationMs: result.durationMs } : {}),
    at: result.timestamp - (result.durationMs ?? 0),
  };
}

function callTool(call: ToolCall, result: ToolResultMessage | undefined, slot: ToolSlot | undefined, pending: boolean): ToolView {
  const { id, name, arguments: args } = call;
  if (result) {
    const tool = resultTool(result);
    return { ...tool, name, args, output: tool.output || slot?.output || "" };
  }
  const status = slot ? (slot.status === "done" ? "error" : slot.status) : (pending ? "pending" : "interrupted");
  return { id, name, args, status, output: slot?.output ?? "", details: slot?.details };
}

/**
 * Display items of each entry, with what they were built from. Chord keeps unchanged entries (and documents' unchanged
 * parts) as the same objects, so while an entry, its tools' results and live slots and the busy flags stay the same,
 * its items are the same objects too, and the memoized components showing them skip rendering. A streaming delta then
 * re-renders the live message, not the whole transcript.
 */
const itemCache = new WeakMap<EntryRecord, { inputs: readonly unknown[]; item: Item }>();
const liveItems = new WeakMap<AssistantMessage, Item>();
const compactionFailureItems = new WeakMap<CompactionFailure, Item>();
/** Null for a failure that shows nothing (`runFailureText`). */
const runFailureItems = new WeakMap<RunFailure, Item | null>();
const gapItems = new WeakMap<Gap, Extract<Item, { type: "gap" }>>();

/** A response's identity from its partial to its committed entry: the time the provider started it. */
function responseKey(message: AssistantMessage): string {
  return `response-${message.timestamp}`;
}

function cachedItem(entry: EntryRecord, inputs: readonly unknown[], build: () => Item): Item {
  const cached = itemCache.get(entry);
  if (cached && cached.inputs.length === inputs.length && cached.inputs.every((input, index) => input === inputs[index])) {
    return cached.item;
  }
  const item = build();
  itemCache.set(entry, { inputs, item });
  return item;
}

/** What a run that ended without an answer shows (`pi.live.runFailure`); nothing for a Stop or a new context. */
function runFailureText(failure: RunFailure): string | undefined {
  const detail = failure.detail?.trim();
  switch (failure.reason) {
    // The detail names the error, or the missing model ("Model faux/gone is not available").
    case "model_error":
    case "no_model":
      return `The model could not answer this input.${detail ? ` ${detail}` : ""}`;
    case "faulted":
      return `The run failed${detail ? `: ${detail}` : "."}`;
    case "orphaned":
      return `The run could not continue${detail ? `: ${detail}` : "."}`;
    case "interrupted":
      return "The answer was interrupted: the server stopped while the model was answering.";
    // The detail says what was cut off how often ("The generation was interrupted 5 times in its request phase").
    case "restart_limit":
      return `The run was stopped after repeated restarts.${detail ? ` ${detail}.` : ""}`;
    case "aborted":
    case "reset":
    case "nothing_to_answer":
    case "turn_limit":
      return undefined;
  }
}

function liveFailures(live: LiveState | undefined): Item[] {
  const items: Item[] = [];
  const { compactionFailure, runFailure } = live ?? {};
  if (compactionFailure) {
    let item = compactionFailureItems.get(compactionFailure);
    if (!item) {
      item = {
        type: "failure",
        key: `compaction-failure-${compactionFailure.taskId}`,
        text: `Compaction failed: ${compactionFailure.error}`,
      };
      compactionFailureItems.set(compactionFailure, item);
    }
    // State-derived, not a retained entry: it persists while idle and disappears when Durable clears it.
    items.push(item);
  }
  // Why the last run ended without an answer, until the next run starts; a blocking compaction failure is shown once.
  if (runFailure && !(compactionFailure && runFailure.detail === `Compaction failed: ${compactionFailure.error}`)) {
    let item = runFailureItems.get(runFailure);
    if (item === undefined) {
      const text = runFailureText(runFailure);
      item = text === undefined ? null : { type: "failure", key: `run-failure-${runFailure.taskId}`, text };
      runFailureItems.set(runFailure, item);
    }
    if (item) items.push(item);
  }
  return items;
}

function gapItem(gap: Gap, filling: ReadonlySet<string>): Item {
  const key = gapKey(gap);
  const loading = filling.has(key);
  const cached = gapItems.get(gap);
  if (cached?.loading === loading) return cached;
  const item = { type: "gap", key, gap, loading } as const;
  gapItems.set(gap, item);
  return item;
}

function committedItems(view: TranscriptView, live: LiveState | undefined, filling: ReadonlySet<string>) {
  const results = new Map<string, ToolResultMessage>();
  const called = new Set<string>();
  let latest: EntryRecord | undefined;
  for (const item of view.items) {
    if (item.kind !== "entry") continue;
    const message = item.entry.model?.[0];
    if (message?.role === "toolResult") results.set(message.toolCallId, message);
    if (message?.role !== "assistant") continue;
    latest = item.entry;
    for (const part of message.content) if (part.type === "toolCall") called.add(part.id);
  }
  // Durable 1.5.2 also writes the failed response as an entry. An empty response from the failed task would show
  // the same notice twice; retain the recorded response once the live failure clears.
  const failure = live?.runFailure;
  const lastMessage = latest?.model?.[0];
  const duplicate = failure?.reason === "model_error" && failure.taskId === latest?.byTaskId &&
    lastMessage?.role === "assistant" && lastMessage.stopReason === "error" &&
    lastMessage.content.every((part) => part.type === "text" && !part.text.trim()) &&
    failure.detail === (lastMessage.errorMessage ?? "Model response ended with stop reason error") ? latest : undefined;
  const slots = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
  /** Keys of responses already placed: a second response started in the same millisecond keys by its entry. */
  const responseKeys = new Set<string>();

  function entryItem(entry: EntryRecord): Item | undefined {
    const message = entry.model?.[0];
    const key = String(entry.id);
    if (entry.kind === "pi.reset") return undefined;
    if (entry.kind === "pi.compaction") {
      return cachedItem(entry, [], () => ({
        type: "marker", key, label: "Context compacted", detail: message ? text(message.content) : "",
      }));
    }
    if (message?.role === "user") {
      return cachedItem(entry, [], () => ({
        type: "user", key, entryId: entry.id, at: message.timestamp, text: text(message.content),
      }));
    }
    if (message?.role === "toolResult" && !called.has(message.toolCallId)) {
      return cachedItem(entry, [], () => ({ type: "tool", key, tool: resultTool(message) }));
    }
    if (message?.role !== "assistant" || entry === duplicate) return undefined;

    // Keep empty abnormal responses visible; context filtering is not a display filter. Calls of the newest
    // response without a result or slot are pending while busy; older ones were interrupted.
    const pending = Boolean(live?.run) && entry === latest;
    const calls = message.content.filter((part) => part.type === "toolCall").map((call) => {
      const result = results.get(call.id);
      const slot = slots.get(call.id);
      return { call, result, slot, pending: !result && !slot && pending };
    });
    // The response's start time is also the partial's key: React keeps the row when the answer commits.
    const response = responseKey(message);
    const itemKey = responseKeys.has(response) ? key : response;
    responseKeys.add(response);
    const inputs = [itemKey, ...calls.flatMap(({ result, slot, pending }) => [result, slot, pending])];
    return cachedItem(entry, inputs, () => ({
      type: "assistant",
      key: itemKey,
      entryId: entry.id,
      message,
      tools: calls.map(({ call, result, slot, pending }) => callTool(call, result, slot, pending)),
      streaming: false,
    }));
  }

  const items: Item[] = [];
  for (const item of view.items) {
    const shown = item.kind === "entry" ? entryItem(item.entry) : item.kind === "gap" ? gapItem(item, filling) : undefined;
    if (shown) items.push(shown);
  }
  return { items, responseKeys };
}

/**
 * The display items of a conversation's transcript and the live state of the view's documents. `filling` names the
 * gaps being loaded (`gapKey` in state.ts).
 */
export function buildTranscript(view: TranscriptView, filling: ReadonlySet<string> = new Set()): Transcript {
  // SAFETY: These are Durable's own built-in documents, received in its conversation view as JSON.
  const live = view.docs["pi.live"] as LiveState | undefined;
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  const { items, responseKeys } = committedItems(view, live, filling);
  const partial = live?.generation?.message;
  if (partial) {
    let item = liveItems.get(partial);
    if (!item) {
      item = { type: "assistant", key: responseKey(partial), message: partial, tools: [], streaming: true };
      liveItems.set(partial, item);
    }
    items.push(responseKeys.has(item.key) ? { ...item, key: "live" } : item);
  }
  items.push(...liveFailures(live));
  const busy = Boolean(live?.run);
  return {
    items,
    busy,
    // Keep one stable activity signal through thinking, text, tools and compaction.
    // It disappears only when the viewed conversation is actually idle.
    working: busy || Boolean(live?.compactions?.length),
    ...(live?.generation?.retry ? { retry: live.generation.retry } : {}),
    compactions: (live?.compactions ?? []).map(({ taskId, blocking, retry }) => ({
      id: taskId, blocking, ...(retry ? { retry } : {}),
    })),
    queued: (inbox?.items ?? []).flatMap((item) =>
      item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, text: text(item.content) }],
    ),
  };
}
