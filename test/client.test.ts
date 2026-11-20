import { describe, expect, it } from "vitest";
import { ChatState } from "../src/client/state.ts";
import type { ServerMessage } from "../src/protocol.ts";

/** A frame as the socket delivers it. */
function frame(value: object): ServerMessage {
  return JSON.parse(JSON.stringify(value));
}

const user = (id: number, text: string) => ({
  id,
  conversationId: 1,
  kind: "user",
  model: [{ role: "user", content: text, timestamp: 0 }],
});

describe("ChatState", () => {
  it("applies ops to the last view and keeps entries the window dropped", () => {
    const state = new ChatState();
    state.receive(frame({ type: "view", view: { conversation: { id: 1 }, entries: [user(1, "hi")], docs: {} } }));
    state.receive(
      frame({
        type: "ops",
        ops: [
          ["p", ["entries"], 0, 1, [user(2, "again")]],
          ["s", ["before"], 1],
          ["s", ["docs", "pi.live"], { run: { taskId: 3, inputs: [], turns: 0 } }],
        ],
      }),
    );

    expect(state.shown?.items.map((item) => item.kind === "entry" && item.entry.id)).toEqual([1, 2]);
    expect(state.shown?.docs["pi.live"]).toEqual({ run: { taskId: 3, inputs: [], turns: 0 } });
  });

  it("keeps a prompt with its requestId until its result", () => {
    const state = new ChatState();
    state.prompt("one", "a");
    state.prompt("two", "b");
    state.receive(frame({ type: "result", requestId: "a", ok: true }));

    expect(state.unanswered()).toEqual([{ type: "prompt", requestId: "b", content: "two" }]);
  });

  it("shows a failed result and stops sending its prompt", () => {
    const state = new ChatState();
    state.prompt("one", "a");
    state.receive(frame({ type: "result", requestId: "a", ok: false, error: "closed" }));

    expect(state.error).toBe("closed");
    expect(state.unanswered()).toEqual([]);
  });

  it("refuses a prompt the server would close the socket for", () => {
    const state = new ChatState();

    expect(state.prompt("x".repeat(64_000), "a")).toBeUndefined();
    expect(state.error).toBe("The message is too long.");
    expect(state.unanswered()).toEqual([]);
  });
});
