// Adapted from p2 (apps/p2/test/p2/failed-turns.test.ts and ui-transcript-stability.test.ts).
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord, TranscriptItem, TranscriptView } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/client/Markdown.tsx";
import { gapKey } from "../src/client/state.ts";
import { buildTranscript } from "../src/client/transcript.ts";

// SAFETY: These entry and conversation IDs are positive integers, as in Durable's wire view.
const conversationId = 1 as EntryRecord["conversationId"];
function entry(id: number, kind: string, model: EntryRecord["model"]): Extract<TranscriptItem, { kind: "entry" }> {
  return { kind: "entry", entry: { id: id as EntryRecord["id"], conversationId, kind, model } };
}

const view = (items: readonly TranscriptItem[], docs: TranscriptView["docs"] = {}): TranscriptView => ({
  conversation: { id: conversationId }, items, docs,
});

const args = { text: "stretch", seconds: 3 };
const call = entry(2, "pi.assistant", [fauxAssistantMessage(
  [{ type: "toolCall", id: "call1", name: "remind", arguments: args }],
  { stopReason: "toolUse", timestamp: 500 },
)]);
const result = entry(3, "pi.tool-result", [{
  role: "toolResult", toolCallId: "call1", toolName: "remind", isError: false, timestamp: 530, durationMs: 25,
  content: [{ type: "text", text: "Reminder set" }], details: { seconds: 3 },
}]);
const run = { taskId: 9, inputs: [], turns: 1 };

function liveView(items: readonly TranscriptItem[], live: NonNullable<TranscriptView["docs"][string]>) {
  return view(items, { "pi.live": live });
}

describe("buildTranscript", () => {
  it("joins a result to its call without showing the same result as another row", () => {
    expect(buildTranscript(view([call, result])).items).toMatchObject([{
      type: "assistant",
      entryId: 2,
      tools: [{ id: "call1", name: "remind", args, status: "done", output: "Reminder set", at: 505,
        durationMs: 25, details: { seconds: 3 } }],
    }]);
  });

  it("shows a result whose call is outside the loaded window", () => {
    expect(buildTranscript(view([{ kind: "earlier" }, result])).items).toMatchObject([{
      type: "tool", tool: { id: "call1", status: "done", output: "Reminder set" },
    }]);
  });

  it("shows running output and details from the tool's live slot", () => {
    const tools = [{ callId: "call1", name: "remind", status: "running", output: "Scheduling", details: { seconds: 3 } }];
    expect(buildTranscript(liveView([call], { run, tools })).items).toMatchObject([{
      type: "assistant", tools: [{ id: "call1", args, status: "running", output: "Scheduling", details: { seconds: 3 } }],
    }]);
  });

  it("changes an unstarted call from pending to interrupted when its run ends without a result", () => {
    expect(buildTranscript(liveView([call], { run })).items).toMatchObject([{
      type: "assistant", tools: [{ id: "call1", status: "pending" }],
    }]);
    expect(buildTranscript(view([call])).items).toMatchObject([{
      type: "assistant", tools: [{ id: "call1", status: "interrupted" }],
    }]);
  });

  it("keeps old items during streaming and the streaming row's key when it commits", () => {
    const user = entry(4, "pi.user", [{ role: "user", content: "Hi", timestamp: 600 }]);
    const at = 700;
    function streaming(text: string) {
      // The provider message arrives in the live document as JSON, not as an in-process model message.
      const message = JSON.parse(JSON.stringify(fauxAssistantMessage(text, { timestamp: at })));
      return buildTranscript(liveView([call, result, user], { run, generation: { attempt: 1, message } })).items;
    }
    const first = streaming("Hel");
    const second = streaming("Hello");
    const committed = buildTranscript(view([call, result, user,
      entry(5, "pi.assistant", [fauxAssistantMessage("Hello", { timestamp: at })]),
    ])).items;
    expect(first).toMatchObject([
      { type: "assistant", entryId: 2 },
      { type: "user", entryId: 4, text: "Hi" },
      { type: "assistant", streaming: true, message: { content: [{ text: "Hel" }] } },
    ]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    const key = first[2]?.key;
    expect(second[2]).toMatchObject({ key, streaming: true, message: { content: [{ text: "Hello" }] } });
    expect(committed[2]).toMatchObject({ key, streaming: false, entryId: 5 });
  });

  it("explains why the last run failed until Durable clears the failure", () => {
    const runFailure = { taskId: 9, inputs: [], reason: "model_error", detail: "  Provider unavailable  " };
    expect(buildTranscript(liveView([], { runFailure })).items).toMatchObject([
      { type: "failure", text: "The model could not answer this input. Provider unavailable" },
    ]);
    expect(buildTranscript(liveView([], { run })).items).toEqual([]);
  });

  it("shows the live failure instead of a duplicate empty error entry from the same task", () => {
    const detail = "Provider unavailable";
    const runFailure = { taskId: 9, inputs: [], reason: "model_error", detail };
    const failed = entry(5, "pi.assistant", [fauxAssistantMessage("", { stopReason: "error", errorMessage: detail })]);
    // SAFETY: The task ID is a positive integer, as delivered by Durable.
    const recorded = { ...failed, entry: { ...failed.entry, byTaskId: 9 as EntryRecord["byTaskId"] } };
    expect(buildTranscript(liveView([recorded], { runFailure })).items).toMatchObject([
      { type: "failure", text: "The model could not answer this input. Provider unavailable" },
    ]);
    expect(buildTranscript(view([recorded])).items).toMatchObject([
      { type: "assistant", message: { stopReason: "error", errorMessage: detail } },
    ]);
  });

  it("shows a blocking compaction failure only once, even when it also ended the run", () => {
    const compactionFailure = { taskId: 10, trigger: "overflow", error: "Summary unavailable" };
    const runFailure = { taskId: 9, inputs: [], reason: "model_error", detail: "Compaction failed: Summary unavailable" };
    expect(buildTranscript(liveView([], { compactionFailure, runFailure })).items).toMatchObject([
      { type: "failure", text: "Compaction failed: Summary unavailable" },
    ]);
  });

  it("includes queued inputs in order but not internal entry writes", () => {
    const { queued } = buildTranscript(view([], {
      "pi.inbox": { items: [
        { id: 1, mode: "followUp", content: "First" },
        { id: 2, mode: "write", entry: { kind: "internal" } },
        { id: 3, mode: "steer", content: [{ type: "text", text: "Second" }, { type: "text", text: "line" }] },
      ] },
    }));
    expect(queued).toEqual([
      { id: 1, mode: "followUp", text: "First" },
      { id: 3, mode: "steer", text: "Second\nline" },
    ]);
  });

  it("marks a gap as loading when a page is being fetched", () => {
    // SAFETY: A gap between two valid positive entry IDs, as delivered by Durable.
    const gap = { kind: "gap", after: 1 as EntryRecord["id"], upTo: 4 as EntryRecord["id"] } as const;
    expect(buildTranscript(view([gap])).items).toMatchObject([{ type: "gap", gap, loading: false }]);
    expect(buildTranscript(view([gap]), new Set([gapKey(gap)])).items).toMatchObject([{ type: "gap", gap, loading: true }]);
  });

  it("projects compaction markers, work and retry notices together", () => {
    const compacted = entry(7, "pi.compaction", [{ role: "user", content: "Summary", timestamp: 800 }]);
    const retry = { at: 900, error: "Provider busy" };
    const transcript = buildTranscript(liveView([compacted], {
      generation: { attempt: 1, retry },
      compactions: [{ taskId: 10, trigger: "threshold", attempt: 1, blocking: false, retry }],
    }));
    expect(transcript).toMatchObject({
      items: [{ type: "marker", label: "Context compacted", detail: "Summary" }],
      busy: false, working: true, retry, compactions: [{ id: 10, blocking: false, retry }],
    });
  });
});

it("renders safe Markdown links, leaves raw tags as text and never fetches remote images", () => {
  const html = renderToStaticMarkup(createElement(Markdown, { text: [
    "<script>alert(0)</script>",
    "Press <kbd>Enter</kbd>.",
    "[Unsafe](javascript:alert(0)) [safe][ref] ![image](https://example.test/image.png)",
    "[ref]: https://example.test/?a=1&amp;b=2",
  ].join("\n\n") }));
  expect(html).toContain("&lt;script&gt;alert(0)&lt;/script&gt;");
  expect(html).toContain("<kbd>Enter</kbd>");
  expect(html).toContain('href="https://example.test/?a=1&amp;b=2"');
  expect(html).toContain('href="https://example.test/image.png"');
  expect(html).not.toMatch(/<script|<img|javascript:/i);
});
