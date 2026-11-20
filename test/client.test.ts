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

/** The transcript asks for entries a few microtasks after the call that needs them. */
const sending = () => new Promise((resolve) => setTimeout(resolve));

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

    expect(state.snapshot.shown?.items.map((item) => item.kind === "entry" && item.entry.id)).toEqual([1, 2]);
    expect(state.snapshot.shown?.docs["pi.live"]).toEqual({ run: { taskId: 3, inputs: [], turns: 0 } });
  });

  it("keeps a prompt with its requestId until its result", () => {
    const state = new ChatState();
    state.prompt("one", "a");
    state.prompt("two", "b");
    state.receive(frame({ type: "result", requestId: "a", ok: true }));

    expect(state.unanswered()).toEqual([{ type: "prompt", requestId: "b", content: "two" }]);
  });

  it("returns the same unanswered list until a prompt joins or leaves it", () => {
    const state = new ChatState();
    state.prompt("one", "a");
    const list = state.unanswered();
    state.receive(frame({ type: "view", view: { conversation: { id: 1 }, entries: [user(1, "hi")], docs: {} } }));
    state.receive(frame({ type: "ops", ops: [["s", ["docs", "pi.live"], {}]] }));
    state.dismissError();

    expect(state.unanswered()).toBe(list);
    state.receive(frame({ type: "result", requestId: "a", ok: true }));
    expect(state.unanswered()).not.toBe(list);
    expect(state.unanswered()).toEqual([]);
  });

  it("shows a failed result and stops sending its prompt", () => {
    const state = new ChatState();
    state.prompt("one", "a");
    state.receive(frame({ type: "result", requestId: "a", ok: false, error: "closed" }));

    expect(state.snapshot.error).toBe("closed");
    expect(state.unanswered()).toEqual([]);
  });

  it("refuses a prompt the server would close the socket for", () => {
    const state = new ChatState();

    expect(state.prompt("x".repeat(64_000), "a")).toBeUndefined();
    expect(state.snapshot.error).toBe("The message is too long.");
    expect(state.unanswered()).toEqual([]);
  });

  it("loads the entries before the window through the socket and puts them first", async () => {
    const sent: object[] = [];
    const state = new ChatState((message) => sent.push(message) > 0);
    state.receive(frame({ type: "view", view: { conversation: { id: 1 }, entries: [user(3, "new")], before: 2, docs: {} } }));
    expect(state.snapshot.earlier).toBe("more");

    const loaded = state.loadEarlier();
    expect(state.snapshot.earlier).toBe("loading");
    await sending();
    expect(sent).toEqual([{ type: "entries", requestId: "entries-1", maxEntryId: 2, order: "descending", limit: 50 }]);
    state.receive(frame({ type: "entries", requestId: "entries-1", entries: [user(2, "old"), user(1, "older")] }));
    await loaded;

    expect(state.snapshot.shown?.items.map((item) => item.kind === "entry" && item.entry.id)).toEqual([1, 2, 3]);
    expect(state.snapshot.earlier).toBeUndefined();
  });

  it("keeps the earlier marker when the socket closes during a load", async () => {
    const state = new ChatState(() => true);
    state.receive(frame({ type: "view", view: { conversation: { id: 1 }, entries: [user(3, "new")], before: 2, docs: {} } }));

    const loaded = state.loadEarlier();
    await sending();
    state.disconnected();
    await loaded;

    expect(state.snapshot.earlier).toBe("more");
  });

  it("leaves what is shown and the unanswered list alone when a load of earlier entries fails", async () => {
    const state = new ChatState(() => false);
    state.receive(frame({ type: "view", view: { conversation: { id: 1 }, entries: [user(3, "new")], before: 2, docs: {} } }));
    state.prompt("waiting", "a");
    const { shown } = state.snapshot;
    const list = state.unanswered();

    await state.loadEarlier();

    expect(state.snapshot.shown).toBe(shown);
    expect(state.unanswered()).toBe(list);
  });
});
