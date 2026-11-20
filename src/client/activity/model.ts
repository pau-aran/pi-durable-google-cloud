// Adapted from p2 (apps/p2/src/web/activity/model.ts), at p2's default detail (2): the agent's texts show in the
// transcript, its thinking and tool calls on a wheel between them. CONTRACT: the exported types and the signature of
// `chatItems` are shared by the transcript and the activity. The body of `chatItems` is a stub.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Item, ToolView } from "../transcript.ts";

export type StepStatus = "running" | "done" | "error";
/** One tool call of an activity. */
export type Step = { id: string; tool: ToolView; status: StepStatus };
/** A thinking block on a wheel. */
export type Words = { kind: "thought"; id: string; text: string; live: boolean };
/** What a wheel rolls through, in order: its tool calls, and the thinking among them. */
export type WheelEntry = { kind: "call"; step: Step } | Words;

/** The items the chat shows: the transcript's people, markers and failures, and each turn's parts in order. */
export type ChatItem =
  | Exclude<Item, { type: "assistant" } | { type: "tool" }>
  | {
      type: "activity";
      key: string;
      /** The run's tool calls. */
      steps: Step[];
      /** Everything on the wheel in order, thinking among the calls. */
      entries?: WheelEntry[];
      /** The agent is still at it: the row is a ticker, not a summary. */
      working: boolean;
      /** When the run began (the response with its first call) and, once done, ended, in ms. */
      startedAt?: number;
      endedAt?: number;
    }
  | {
      /** The agent's text between its calls, as prose; the turn's last text is its answer instead. */
      type: "text";
      key: string;
      entryId?: number;
      text: string;
    }
  | {
      type: "answer";
      key: string;
      entryId?: number;
      text: string;
      /** The response it ends: for a stop, an error or the length limit below it. */
      message: AssistantMessage;
      streaming: boolean;
    };

/**
 * The chat's items: the agent's responses between two people's messages (or markers and failures) become one run,
 * shown as its texts and wheels in order and its answer. `working`: the agent is at it, so the last run is live.
 */
export function chatItems(items: readonly Item[], working: boolean): ChatItem[] {
  const shown: ChatItem[] = [];
  for (const item of items) {
    if (item.type === "tool") continue;
    if (item.type !== "assistant") {
      shown.push(item);
      continue;
    }
    const text = item.message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    shown.push({ type: "answer", key: item.key, entryId: item.entryId, text, message: item.message, streaming: item.streaming });
  }
  if (working && shown.at(-1)?.type === "user") shown.push({ type: "activity", key: "activity:waiting", steps: [], working: true });
  return shown;
}
