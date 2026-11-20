// The chat's turns (src/client/activity/model.ts), ported from p2's test/p2/activity-model.test.ts at its default
// detail: a turn's texts stay in the transcript, its thinking and calls go on wheels between them, the last text is the
// answer; the last run is live while the agent works; unchanged rows keep their objects.
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  type ChatItem,
  chatItems,
  describe as describeStep,
  live,
  type Step,
  stepState,
  summary,
} from "../src/client/activity/model.ts";
import type { Item, ToolView } from "../src/client/transcript.ts";

type Response = Extract<Item, { type: "assistant" }>;
type Activity = Extract<ChatItem, { type: "activity" }>;

const user = (key: string, text: string): Item => ({ type: "user", key, text, entryId: 1 });

function response(
  key: string,
  entryId: number | undefined,
  content: AssistantMessage["content"],
  tools: ToolView[] = [],
  extra: Partial<AssistantMessage> = {},
): Response {
  return {
    type: "assistant",
    key,
    ...(entryId === undefined ? {} : { entryId }),
    message: { ...fauxAssistantMessage([]), content, stopReason: "stop", timestamp: 1_000, ...extra },
    tools,
    streaming: entryId === undefined,
  };
}

const tool = (id: string, name: string, args: Record<string, unknown>, extra: Partial<ToolView> = {}): ToolView => ({
  id,
  name,
  args,
  status: "done",
  output: "",
  ...extra,
});

const remind = (id: string, text = "stretch") => tool(id, "remind", { text, seconds: 60 }, { output: "Reminder set." });
const call = (each: ToolView): ToolCall => ({
  type: "toolCall",
  id: each.id,
  name: each.name,
  arguments: each.args as ToolCall["arguments"],
});
const shape = (items: readonly ChatItem[]) =>
  items.map((item) =>
    item.type === "activity"
      ? `activity:${(item.entries ?? []).map((each) => (each.kind === "call" ? each.step.tool.name : each.kind)).join(",")}`
      : item.type,
  );
const step = (each: ToolView, status: Step["status"]): Step => ({ id: each.id, tool: each, status });

describe("chatItems", () => {
  it("makes a turn with a call and an answer a wheel and the answer, timed from the call to the answer", () => {
    const made = [
      user("u1", "Remind me"),
      response("a1", 2, [call(remind("t1"))], [remind("t1")], { timestamp: 1_000, stopReason: "toolUse" }),
      response("a2", 3, [{ type: "text", text: "Done." }], [], { timestamp: 4_000 }),
    ];
    const items = chatItems(made, false);
    expect(shape(items)).toEqual(["user", "activity:remind", "answer"]);
    expect(items[1]).toMatchObject({ key: "activity:u1", working: false, startedAt: 1_000, endedAt: 4_000 });
    expect(items[2]).toMatchObject({ type: "answer", text: "Done.", entryId: 3 });
  });

  it("keeps the working row's key when the first response arrives, with a pending call running on it", () => {
    const waiting = chatItems([user("u1", "Remind me")], true);
    expect(waiting.at(-1)).toMatchObject({ type: "activity", key: "activity:u1", steps: [], working: true });
    // The call has no tool view yet: the wheel shows it pending, as running.
    const calling = chatItems([user("u1", "Remind me"), response("live", undefined, [call(remind("t1"))])], true);
    const wheel = calling.at(-1) as Activity;
    expect(wheel).toMatchObject({ key: "activity:u1", working: true });
    expect(wheel.steps.map((each) => [each.tool.name, each.tool.status, each.status])).toEqual([
      ["remind", "pending", "running"],
    ]);
  });

  it("keeps a text before a call in the transcript and makes the last text the answer", () => {
    const items = chatItems(
      [
        user("u1", "Go"),
        response("a1", 2, [{ type: "text", text: "First a reminder." }, call(remind("t1"))], [remind("t1")]),
        response("a2", 3, [{ type: "text", text: "Now another." }, call(remind("t2"))], [remind("t2")]),
        response("a3", 4, [{ type: "text", text: "Both set." }]),
      ],
      false,
    );
    expect(shape(items)).toEqual(["user", "text", "activity:remind", "text", "activity:remind", "answer"]);
    expect(items.map((item) => ("text" in item ? item.text : undefined))).toEqual([
      "Go",
      "First a reminder.",
      undefined,
      "Now another.",
      undefined,
      "Both set.",
    ]);
    // Words that turn out not to be the last (a call follows) keep their row's key: the answer was that text's row.
    const streaming = chatItems([user("u2", "Go"), response("live", undefined, [{ type: "text", text: "One" }])], true);
    const called = chatItems(
      [user("u2", "Go"), response("live", undefined, [{ type: "text", text: "One two" }, call(remind("t3"))])],
      true,
    );
    expect(streaming.at(-1)?.type).toBe("answer");
    expect(called[1]).toMatchObject({ type: "text", key: streaming.at(-1)?.key });
  });

  it("puts thinking on the wheel with the calls, one thought for consecutive blocks, live while it streams", () => {
    const content: AssistantMessage["content"] = [
      { type: "thinking", thinking: "First." },
      { type: "thinking", thinking: "Second." },
      call(remind("t1")),
      { type: "thinking", thinking: "Now answer." },
    ];
    const items = chatItems([user("u1", "Go"), response("live", undefined, content, [remind("t1")])], true);
    expect(shape(items)).toEqual(["user", "activity:thought,remind,thought"]);
    const wheel = items[1] as Activity;
    expect(wheel.steps.map((each) => each.id)).toEqual(["t1"]);
    expect(wheel.entries?.filter((entry) => entry.kind === "thought")).toMatchObject([
      { text: "First.\n\nSecond.", live: false },
      { text: "Now answer.", live: true },
    ]);
    // A thought alone before the first text is a wheel of its own, keyed like the row that waited for it.
    const before = chatItems(
      [user("u1", "Go"), response("a1", 2, [{ type: "thinking", thinking: "Hm." }, { type: "text", text: "Hi." }])],
      false,
    );
    expect(shape(before)).toEqual(["user", "activity:thought", "answer"]);
    expect(before[1]?.key).toBe("activity:u1");
  });

  it("returns the same objects for an unchanged run, and keeps the wheel while the answer streams", () => {
    const made = [
      user("u1", "Go"),
      response("a1", 2, [call(remind("t1"))], [remind("t1")]),
      response("a2", 3, [{ type: "text", text: "Done." }]),
    ];
    const first = chatItems(made, false);
    const again = chatItems([...made], false);
    expect(again.every((item, index) => item === first[index])).toBe(true);
    const streaming = (text: string) => [...made.slice(0, 2), response("live", undefined, [{ type: "text", text }])];
    const start = chatItems(streaming("One"), true);
    const later = chatItems(streaming("One two"), true);
    expect(later[1]).toBe(start[1]);
    expect(later[2]).not.toBe(start[2]);
    expect(later[2]).toMatchObject({ type: "answer", text: "One two" });
  });

  it("shows a stopped turn without text as an answer, for its notice", () => {
    const items = chatItems(
      [
        user("u1", "Go"),
        response("a1", 2, [call(remind("t1"))], [{ ...remind("t1"), status: "interrupted" }], { stopReason: "error" }),
      ],
      false,
    );
    expect(shape(items)).toEqual(["user", "activity:remind", "answer"]);
    expect(items[2]).toMatchObject({ key: "answer:a1", text: "" });
    expect((items[1] as Activity).steps[0]?.status).toBe("error");
  });

  it("joins each call's status into its step's state", () => {
    const tools = [
      { ...remind("r"), status: "running" as const },
      { ...remind("d"), durationMs: 1_500 },
      { ...remind("e"), status: "error" as const, output: "The delay is at most a year." },
      { ...remind("i"), status: "interrupted" as const },
    ];
    const items = chatItems([user("u1", "Go"), response("a1", 2, tools.map(call), tools)], true);
    expect((items[1] as Activity).steps.map(stepState)).toEqual(["● running", "✓ 1.5s", "✗ failed", "✗ interrupted"]);
  });
});

describe("a step's words", () => {
  it("says what remind did and is doing, and names any other tool by its name and first string argument", () => {
    expect(describeStep(step(remind("r", "stretch\nnow"), "done"))).toEqual({
      kind: "reminder",
      verb: "Set a reminder:",
      object: "stretch",
      style: "words",
    });
    expect(live(step(remind("r"), "running"))).toMatchObject({ verb: "Setting a reminder:", object: "stretch" });
    // Its arguments still streaming: no text yet, and no colon before it.
    expect(live(step(tool("r", "remind", {}, { status: "pending" }), "running"))).toEqual({
      kind: "reminder",
      verb: "Setting a reminder",
    });
    const fetch = tool("f", "web_fetch", { limit: 3, url: "https://example.com\nmore" });
    expect(describeStep(step(fetch, "done"))).toEqual({
      kind: "tool",
      verb: "web_fetch",
      object: "https://example.com",
      style: "code",
    });
    expect(live(step(fetch, "running"))).toEqual(describeStep(step(fetch, "done")));
  });

  it("summarises one and several reminders, and an unknown tool by name", () => {
    expect(summary([step(remind("a"), "done")])).toBe("Set a reminder");
    expect(summary([step(remind("a"), "done"), step(remind("b"), "error")])).toBe("Set 2 reminders");
    const grep = step(tool("g", "grep", {}), "done");
    expect(summary([grep])).toBe("Used grep");
    expect(summary([step(remind("a"), "done"), grep, grep])).toBe("Set a reminder, used grep 2 times");
    expect(summary([])).toBe("Done");
  });
});
