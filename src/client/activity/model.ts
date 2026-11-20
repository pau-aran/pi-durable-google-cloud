// Adapted from p2 (apps/p2/src/web/activity/model.ts), at p2's default detail (2): the agent's texts show in the
// transcript, its thinking and tool calls on a wheel between them.
//
// A turn's activity: what the agent did between a person's message and its answer. Derived from the transcript's
// items: `chatItems` keeps each response's text in the transcript, in its order, and turns each stretch of tool calls
// and thinking between them into an activity item (a wheel in the chat, its steps expandable below it). A turn's last
// text is its answer.
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

const toolStatus = (tool: ToolView): StepStatus =>
  tool.status === "error" || tool.status === "interrupted" ? "error" : tool.status === "done" ? "done" : "running";

type Response = Extract<Item, { type: "assistant" }>;
/** A run of consecutive tool calls, with the responses that made them (for its time). */
type Calls = { type: "calls"; key: string; steps: Step[]; from: Response[]; entries?: WheelEntry[] };
/** A thinking block, before it goes on a wheel. */
type Thought = { type: "thought"; key: string; entryId?: number; text: string; live: boolean };
type Text = Extract<ChatItem, { type: "text" }>;
type Part = Calls | Thought | Text;

const stepOf = (tool: ToolView): Step => ({ id: tool.id, tool, status: toolStatus(tool) });

/**
 * A run of responses as its parts in order: thinking, text and runs of calls (results whose call is outside the loaded
 * window join them). A run of calls that comes first is keyed by what came before it (`after`), so its wheel is the
 * same row as the one that waited for it.
 */
function partsOf(run: readonly Item[], live: boolean, after: string): Part[] {
  const parts: Part[] = [];
  const call = (key: string, tool: ToolView, from?: Response) => {
    const last = parts.at(-1);
    if (last?.type === "calls") {
      if (from && last.from.at(-1) !== from) last.from.push(from);
      last.steps.push(stepOf(tool));
      return;
    }
    const first = !last ? `activity:${after}` : key;
    parts.push({ type: "calls", key: first, steps: [stepOf(tool)], from: from ? [from] : [] });
  };
  for (const item of run) {
    if (item.type === "tool") {
      call(`activity:${item.key}`, item.tool);
      continue;
    }
    if (item.type !== "assistant") continue;
    const tools = new Map(item.tools.map((tool) => [tool.id, tool]));
    const last = item.message.content.length - 1;
    const entry = item.entryId === undefined ? {} : { entryId: item.entryId };
    for (const [index, part] of item.message.content.entries()) {
      const key = `${item.key}:${index}`;
      if (part.type === "thinking" && part.thinking.trim()) {
        const thinking = item.streaming && live && index === last;
        const before = parts.at(-1);
        // Thinking right after thinking (nothing shown between them) is one thought: its texts in order.
        if (before?.type === "thought")
          parts[parts.length - 1] = { ...before, text: `${before.text}\n\n${part.thinking}`, live: thinking };
        else parts.push({ type: "thought", key: `thought:${key}`, ...entry, text: part.thinking, live: thinking });
      } else if (part.type === "text" && part.text.trim())
        parts.push({ type: "text", key: `text:${key}`, ...entry, text: part.text });
      else if (part.type === "toolCall") {
        const tool = tools.get(part.id) ?? {
          id: part.id,
          name: part.name,
          args: part.arguments ?? {},
          status: "pending" as const,
          output: "",
        };
        call(`activity:${key}`, tool, item);
      }
    }
  }
  return parts;
}

/** A run of calls as its wheel: live while it is the turn's last part and the agent works. */
function activityOf(calls: Calls, responses: readonly Response[], working: boolean): ChatItem {
  const first = calls.from[0];
  const last = calls.from.at(-1);
  const startedAt = first?.message.timestamp;
  // Done: when the next response began, or the last response's calls ended.
  const next = last ? responses[responses.indexOf(last) + 1] : undefined;
  const endedAt =
    working || !last
      ? undefined
      : (next?.message.timestamp ??
        last.message.timestamp + last.tools.reduce((sum, each) => sum + (each.durationMs ?? 0), 0));
  return {
    type: "activity",
    key: calls.key,
    steps: calls.steps,
    working,
    ...(startedAt ? { startedAt } : {}),
    ...(startedAt && endedAt ? { endedAt } : {}),
  };
}

/** A run's chat items: its texts and wheels in order, the answer (its last text, when nothing came after it). */
function runItems(run: readonly Item[], working: boolean, after: string): ChatItem[] {
  const parts = partsOf(run, working, after);
  const responses = run.filter((item): item is Response => item.type === "assistant");
  const response = responses.at(-1);
  const last = parts.at(-1);
  // The run's last text is its answer, when nothing came after it.
  const answer = last?.type === "text" ? last : undefined;
  if (answer) parts.pop();
  // The thinking goes on the wheels with the calls, merged into them.
  const merged = wheels(parts, responses, after);
  const final = merged.at(-1);
  const notice = response && ["error", "aborted", "length"].includes(response.message.stopReason) && !response.streaming;
  const items: ChatItem[] = merged.map((part) =>
    part.type === "calls"
      ? {
          ...activityOf(part, responses, working && !answer && part === final),
          ...(part.entries ? { entries: part.entries } : {}),
        }
      : part,
  );
  // Working on a response that shows nothing yet: the activity row, waiting.
  if (working && !answer && !final) items.push({ type: "activity", key: `activity:${after}`, steps: [], working: true });
  if (response && (answer || notice))
    items.push({
      type: "answer",
      // The answer is its text's row: a text that turns out not to be the last (a call follows) keeps its row.
      key: answer?.key ?? `answer:${response.key}`,
      ...(response.entryId !== undefined ? { entryId: response.entryId } : {}),
      text: answer?.text ?? "",
      message: response.message,
      streaming: response.streaming,
    });
  return items;
}

/**
 * Parts with the thinking merged into the runs of calls around it: each stretch between the texts is one wheel, keyed
 * by its first part (the turn's first by the item before the run, `after`, as the wheel that waited for it), timed by
 * the responses of its calls and thinking.
 */
function wheels(parts: readonly Part[], responses: readonly Response[], after: string): (Calls | Text)[] {
  const merged: (Calls | Text)[] = [];
  for (const part of parts) {
    // A text stays in the transcript, between wheels.
    if (part.type === "text") {
      merged.push(part);
      continue;
    }
    let wheel = merged.at(-1);
    if (wheel?.type !== "calls") {
      const key = !wheel ? `activity:${after}` : part.type === "calls" ? part.key : `activity:${part.key}`;
      wheel = { type: "calls", key, steps: [], from: [], entries: [] };
      merged.push(wheel);
    }
    const from = part.type === "calls" ? part.from : responses.filter((response) => response.entryId === part.entryId);
    for (const response of from) if (!wheel.from.includes(response)) wheel.from.push(response);
    if (part.type === "calls") {
      wheel.steps.push(...part.steps);
      wheel.entries?.push(...part.steps.map((step): WheelEntry => ({ kind: "call", step })));
    } else wheel.entries?.push({ kind: "thought", id: part.key, text: part.text, live: part.live });
  }
  // In the responses' order: the first and last time the wheel.
  for (const part of merged)
    if (part.type === "calls") part.from.sort((a, b) => responses.indexOf(a) - responses.indexOf(b));
  return merged;
}

/** A run's items, kept while its members and state are the same, so unchanged rows keep their identity. */
const runs = new WeakMap<Item, { members: readonly Item[]; working: boolean; items: ChatItem[] }>();

/** The items made last, by key, for keeping the ones a rebuilt run shows the same (the newest `RECENT`). */
const recent = new Map<string, ChatItem>();
const RECENT = 2_000;

/** Whether two calls show the same: the same tool view, or one with the same state (a streaming call rebuilt). */
const sameTool = (one: ToolView, other: ToolView): boolean =>
  one === other ||
  (one.id === other.id &&
    one.name === other.name &&
    one.status === other.status &&
    one.output === other.output &&
    one.details === other.details &&
    one.durationMs === other.durationMs &&
    JSON.stringify(one.args) === JSON.stringify(other.args));

/** Whether two steps show the same: the same call in the same state. */
const sameStep = (step: Step, same: Step): boolean =>
  step.id === same.id && step.status === same.status && sameTool(step.tool, same.tool);

/** Whether two wheel entries show the same: the same step, or the same words in the same state. */
function sameEntry(entry: WheelEntry, same: WheelEntry): boolean {
  if (entry.kind === "call") return same.kind === "call" && sameStep(entry.step, same.step);
  return same.kind === entry.kind && same.id === entry.id && same.text === entry.text && same.live === entry.live;
}

const sameValue = (one: unknown, other: unknown): boolean =>
  one === other ||
  (Array.isArray(one) &&
    Array.isArray(other) &&
    one.length === other.length &&
    one.every((value, index) => {
      const that: unknown = other[index];
      if (value === that) return true;
      if (!value || !that || typeof value !== "object" || typeof that !== "object") return false;
      // Any list of a chat item: its members are told apart by the fields they have.
      // An entry on a wheel.
      if ("kind" in value && "kind" in that) return sameEntry(value as WheelEntry, that as WheelEntry);
      // A step: the same call in the same state.
      if ("tool" in value && "tool" in that) return sameStep(value as Step, that as Step);
      return false;
    }));

/** Whether an item rebuilt shows the same as before: then the earlier object stays, and its row does not render. */
function sameItem(one: ChatItem, other: ChatItem): boolean {
  if (one.type !== other.type || one.key !== other.key) return false;
  const keys = Object.keys(one) as (keyof ChatItem)[];
  return (
    keys.length === Object.keys(other).length &&
    keys.every((key) => sameValue(one[key], other[key as keyof typeof other]))
  );
}

/**
 * The chat's items: the agent's responses between two people's messages (or markers and failures) become one run,
 * shown as its texts and wheels in order and its answer. `working`: the agent is at it, so the last run is live.
 */
export function chatItems(items: readonly Item[], working: boolean): ChatItem[] {
  const result: ChatItem[] = [];
  let run: Item[] = [];
  let after = "start";
  const flush = (last: boolean) => {
    const live = last && working;
    // Working before the first response: the activity row, waiting.
    if (!run.length) {
      if (live) result.push({ type: "activity", key: `activity:${after}`, steps: [], working: true });
      return;
    }
    const cached = runs.get(run[0]!);
    if (
      cached &&
      cached.working === live &&
      cached.members.length === run.length &&
      cached.members.every((item, index) => item === run[index])
    )
      result.push(...cached.items);
    else {
      // A member changed (a streaming delta, a result): the run's items are made again, and those that show the same
      // as before stay the same objects. Found by key: a streaming response is a new object at every delta.
      const made = runItems(run, live, after).map((item) => {
        const before = recent.get(item.key);
        const kept = before && sameItem(before, item) ? before : item;
        recent.delete(item.key);
        recent.set(item.key, kept);
        return kept;
      });
      for (const key of recent.keys()) {
        if (recent.size <= RECENT) break;
        recent.delete(key);
      }
      runs.set(run[0]!, { members: run, working: live, items: made });
      result.push(...made);
    }
    run = [];
  };
  for (const item of items) {
    if (item.type === "assistant" || item.type === "tool") {
      run.push(item);
      continue;
    }
    flush(false);
    result.push(item);
    after = item.key;
  }
  flush(true);
  return result;
}

/** A text's first non-empty line, trimmed. */
const firstLine = (text: string): string =>
  text
    .split("\n")
    .find((line) => line.trim())
    ?.trim() ?? "";

/** Markdown as plain words, for a one-line title: code spans, emphasis and links lose their markers. */
export const plainText = (text: string): string =>
  text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

/** The first sentence of a text, for a one-line description. */
export const sentence = (text: string): string => {
  const line = firstLine(text);
  const end = line.search(/[.!?](\s|$)/);
  return end > 0 ? line.slice(0, end + 1) : line;
};

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The kind of work a step is, for its icon. */
export type Kind = "reminder" | "tool";
/** A step's words: a verb and what it acted on, styled by what that is (a command, the agent's words). */
export type Label = { kind: Kind; verb?: string; object?: string; style?: "code" | "words" };

/**
 * How a tool's calls show in the chat, keyed by tool name. Every part is optional; a tool without a contribution, or a
 * part left out, gets the generic one: the tool's name and its first short string argument, a generic icon.
 */
type ToolActivity = {
  /** The call's words in the past tense ("Set a reminder: stretch"). */
  describe?: (step: Step) => Label;
  /** Its words while it runs ("Setting a reminder: stretch"); without it, `describe`'s. */
  running?: (step: Step) => Label;
  /**
   * What a finished run's summary says for `count` of these calls ("set a reminder", "set 3 reminders"). Tools that
   * share the function count together.
   */
  summary?: (count: number) => string;
};
/** Contributions by tool name. */
type ToolActivityTable = ReadonlyMap<string, ToolActivity>;

/** A reminder's words: the verb, then its text as the agent wrote it (none while its arguments stream in). */
const reminder =
  (verb: string) =>
  (step: Step): Label => {
    const text = typeof step.tool.args.text === "string" ? firstLine(step.tool.args.text) : "";
    return text ? { kind: "reminder", verb: `${verb}:`, object: text, style: "words" } : { kind: "reminder", verb };
  };

/** This app's tools (`src/chat.ts`): `remind` sends a text back to the conversation after a delay. */
const TOOLS: ToolActivityTable = new Map<string, ToolActivity>([
  [
    "remind",
    {
      describe: reminder("Set a reminder"),
      running: reminder("Setting a reminder"),
      summary: (count) => (count === 1 ? "set a reminder" : `set ${count} reminders`),
    },
  ],
]);

/** A call's main argument for its row in the step list: its first short string argument. */
export function argumentOf(tool: ToolView): string {
  const value = Object.values(tool.args).find((each) => typeof each === "string" && each.trim());
  return typeof value === "string" ? firstLine(value).slice(0, 120) : "";
}

/** The plain words of a label, for screen readers and tests. */
export const plain = (label: Label) => [label.verb, label.object].filter(Boolean).join(" ");

/** A step's label in the past tense: its tool's words, or the tool's name and first short argument. */
export function describe(step: Step): Label {
  const own = TOOLS.get(step.tool.name)?.describe;
  if (own) return own(step);
  const object = argumentOf(step.tool);
  return { kind: "tool", verb: step.tool.name, ...(object ? { object, style: "code" as const } : {}) };
}

/** A step for the ticker: its label in the present tense while it runs. */
export function live(step: Step): Label {
  const running = TOOLS.get(step.tool.name)?.running;
  return step.status === "running" && running ? running(step) : describe(step);
}

/** A duration as a reader says it: 12s, 1m 05s, 1h 02m. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A step's state for its row in the step list: done with its time, how it failed, running. */
export function stepState(step: Step): string {
  const { tool } = step;
  if (step.status === "running") return "● running";
  if (step.status === "error") return `✗ ${tool.status === "interrupted" ? "interrupted" : "failed"}`;
  const ms = tool.durationMs;
  if (ms === undefined) return "✓";
  return `✓ ${ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : elapsed(ms)}`;
}

/** The summary's words for a tool without its own: "used web_fetch", "used web_fetch 3 times". */
const usedTool = (name: string) => (count: number) => (count === 1 ? `used ${name}` : `used ${name} ${count} times`);

/**
 * One line for a finished run of calls: the tools' own words for what they did, counted, in the order they did it
 * ("Set 2 reminders, used web_fetch"). Its failures show on the wheel, not here.
 */
export function summary(steps: readonly Step[]): string {
  // Keyed by the words' function (tools sharing it count together), or by the name of a tool without one.
  const counts = new Map<unknown, { words: (count: number) => string; count: number }>();
  for (const step of steps) {
    const own = TOOLS.get(step.tool.name)?.summary;
    const key = own ?? step.tool.name;
    const entry = counts.get(key) ?? { words: own ?? usedTool(step.tool.name), count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const parts = [...counts.values()].map(({ words, count }) => words(count));
  return capitalized(parts.join(", ") || "done");
}
