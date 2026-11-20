import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyImmutable } from "@earendil-works/chord/delta";
import { createModels, fauxAssistantMessage, fauxProvider, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type ConversationView, configure, createRegistry, defineExtension, defineTask, type HarnessOptions } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage, ServerMessage } from "../src/protocol.ts";
import { openSessions, type Sessions, type SessionsOptions } from "../src/sessions.ts";

const ID = "00000000-0000-4000-8000-000000000001";

let dataDir: string;
let server: WebSocketServer;
/** The sessions that the server attaches new sockets to. */
let sessions: Sessions;
/** How many times a session asked for its Harness options: one for each open. */
let opens: number;
let faux: ReturnType<typeof fauxProvider>;
let harness: () => HarnessOptions;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sessions-test-"));
  server = new WebSocketServer({ port: 0 });
  server.on("connection", (socket, request) => void sessions.connect(request.url!.slice(1), socket));
  await new Promise((resolve) => server.once("listening", resolve));
  opens = 0;
  faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  harness = () => {
    opens++;
    return {
      models,
      registry: createRegistry(),
      conversationCreated: (tx, conversation) => configure(tx, conversation.id, { model: { provider: model.provider, modelId: model.id } }),
    };
  };
});

afterEach(async () => {
  await sessions.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true });
});

async function open(options: Partial<SessionsOptions> = {}): Promise<void> {
  sessions = await openSessions({ dataDir, harness: () => harness(), ...options });
}

/** A browser: one socket that keeps the view from the `view` and `ops` frames. */
async function connect(id = ID) {
  const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/${id}`);
  const frames: ServerMessage[] = [];
  let view: ConversationView | undefined;
  let changed = () => {};
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString()) as ServerMessage;
    frames.push(frame);
    if (frame.type === "view") view = frame.view;
    if (frame.type === "ops") view = applyImmutable(view, frame.ops);
    changed();
  });
  const closed = new Promise<number>((resolve) => socket.on("close", resolve));
  void closed.then(() => changed());
  await new Promise((resolve) => socket.once("open", resolve));
  return {
    frames,
    closed,
    /** Resolve when `done` is true after a frame; reject when the socket closes first. */
    async until(done: () => boolean): Promise<void> {
      while (!done()) {
        if (socket.readyState === WebSocket.CLOSED) throw new Error("socket closed");
        await new Promise<void>((resolve) => (changed = resolve));
      }
    },
    /** Resolve when the view contains `text`. */
    async shows(text: string): Promise<void> {
      await this.until(() => JSON.stringify(view ?? null).includes(text));
    },
    entries: (kind: string) => view!.entries.filter((entry) => entry.kind === kind),
    send: (message: ClientMessage | string) => socket.send(typeof message === "string" ? message : JSON.stringify(message)),
    async close(): Promise<void> {
      socket.close();
      await closed;
    },
  };
}

/** Resolve when `done` is true, for state that no socket shows. */
async function eventually(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 5));
}

function wakeRows(): unknown[] {
  const wakes = new DatabaseSync(join(dataDir, "wakes.sqlite"));
  try {
    return wakes.prepare("SELECT session_id, at FROM wakes").all();
  } finally {
    wakes.close();
  }
}

/** A timer that the test fires, and a clock that the test moves. */
function fakeTime() {
  let offset = 0;
  let fire: (() => void) | undefined;
  return {
    now: () => Date.now() + offset,
    setTimer: (callback: () => void) => {
      fire = callback;
      return () => (fire = undefined);
    },
    /** Move the clock past the heartbeat and fire the timer. */
    heartbeat() {
      offset += 61_000;
      fire?.();
    },
  };
}

test("a prompt is stored, answered, and shown", async () => {
  faux.setResponses([fauxAssistantMessage("Paris.")]);
  await open();
  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);
  expect(browser.frames[0]!.type).toBe("view");

  browser.send({ type: "prompt", requestId: "r1", content: "Capital of France?" });

  await browser.shows("Paris.");
  expect(browser.frames).toContainEqual({ type: "result", requestId: "r1", ok: true });
  expect(browser.entries("pi.user")).toHaveLength(1);
});

test("two sockets on one session share one Harness and both get the commits", async () => {
  faux.setResponses([fauxAssistantMessage("Shared answer.")]);
  await open();
  const first = await connect();
  const second = await connect();
  await first.until(() => first.frames.length > 0);
  await second.until(() => second.frames.length > 0);

  first.send({ type: "prompt", requestId: "r1", content: "Hello" });

  await first.shows("Shared answer.");
  await second.shows("Shared answer.");
  expect(second.frames.some((frame) => frame.type === "result")).toBe(false);
  expect(opens).toBe(1);
});

test("a repeated requestId submits the prompt once", async () => {
  faux.setResponses([fauxAssistantMessage("Once."), fauxAssistantMessage("Twice.")]);
  await open();
  const browser = await connect();
  const prompt: ClientMessage = { type: "prompt", requestId: "same", content: "Hello" };

  browser.send(prompt);
  browser.send(prompt);
  await browser.until(() => browser.frames.filter((frame) => frame.type === "result").length === 2);
  await browser.shows("Once.");
  await browser.close();
  // The session closes only when no work is left, so a second answer would be in the next view.
  const again = await connect();
  await again.until(() => again.frames.length > 0);

  expect(again.entries("pi.user")).toHaveLength(1);
  expect(again.entries("pi.assistant")).toHaveLength(1);
  expect(faux.state.callCount).toBe(1);
});

test("an idle session closes, and the next socket opens it again", async () => {
  await open();
  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);
  expect(opens).toBe(1);

  await browser.close();
  const again = await connect();
  await again.until(() => again.frames.length > 0);

  expect(opens).toBe(2);
  expect(wakeRows()).toEqual([]);
});

test("a due wake opens a closed session and runs its sleeping task", async () => {
  let delivered = 0;
  const Reminder = defineTask<null, { phase: "wait" } | { phase: "deliver" }, null>({
    name: "test.reminder",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: (_task, runtime, context) => runtime.sleepUntil(runtime.now() + 300, { phase: "deliver" }, context),
      deliver: async (_task, runtime, context) => {
        delivered++;
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });
  const plain = harness;
  harness = () => {
    const options = plain();
    const registry = createRegistry();
    registry.install(defineExtension({ name: "test", tasks: [Reminder] }));
    return {
      ...options,
      registry,
      conversationCreated: async (tx, conversation) => {
        await options.conversationCreated!(tx, conversation);
        await tx.createTask(Reminder, null, { ownership: { kind: "conversation" }, conversationId: conversation.id });
      },
    };
  };
  await open();
  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);
  await eventually(() => wakeRows().length === 1 && opens === 1);

  // The task sleeps, so the session closes when its socket does. Its row stays.
  await browser.close();
  expect(delivered).toBe(0);

  await eventually(() => delivered === 1);
  expect(opens).toBe(2);
  await eventually(() => wakeRows().length === 0);
});

test("a new process finishes the work that a lost process left", async () => {
  // A request that does not end before the process stops.
  const hang: FauxResponseStep = (_context, options) =>
    new Promise((resolve) => options!.signal!.addEventListener("abort", () => resolve(fauxAssistantMessage("Lost.", { stopReason: "aborted" }))));
  faux.setResponses([hang, fauxAssistantMessage("Recovered.")]);
  await open();
  const browser = await connect();
  browser.send({ type: "prompt", requestId: "r1", content: "Hello" });
  await eventually(() => faux.state.callCount === 1);
  await sessions.close();
  expect(wakeRows()).toHaveLength(1);

  // One heartbeat later, the row is due when the next process boots. No socket asks for the session.
  await open({ now: () => Date.now() + 61_000 });
  await eventually(() => faux.state.callCount === 2);

  const again = await connect();
  await again.shows("Recovered.");
  expect(again.entries("pi.user")).toHaveLength(1);
});

test("a failed open closes the socket and is tried again at the heartbeat", async () => {
  const time = fakeTime();
  const good = harness;
  harness = () => {
    harness = good;
    throw new Error("no options");
  };
  const stderr = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = (line: string) => lines.push(line) > 0;
  try {
    await open(time);
    const browser = await connect();
    expect(await browser.closed).toBe(1011);
  } finally {
    process.stderr.write = stderr;
  }
  expect(JSON.parse(lines[0]!)).toEqual({ sessionId: ID, kind: "open_failed", error: "Error: no options" });
  expect(opens).toBe(0);
  expect(wakeRows()).toHaveLength(1);

  time.heartbeat();

  await eventually(() => opens === 1);
  // The open succeeded and found no work, so the session closed and its row is gone.
  await eventually(() => wakeRows().length === 0);
});

test("a frame that is too long or not a ClientMessage closes the socket", async () => {
  await open();
  const long = await connect();
  const invalid = await connect();
  await long.until(() => long.frames.length > 0);
  await invalid.until(() => invalid.frames.length > 0);

  long.send({ type: "prompt", requestId: "r1", content: "x".repeat(64_000) });
  invalid.send(JSON.stringify({ type: "prompt", requestId: 1, content: "Hello" }));

  expect(await long.closed).toBe(1009);
  expect(await invalid.closed).toBe(1002);
});

test("concurrent connects for one closed session open it once", async () => {
  await open();
  const browsers = await Promise.all([connect(), connect(), connect()]);

  await Promise.all(browsers.map((browser) => browser.until(() => browser.frames.length > 0)));

  expect(opens).toBe(1);
});
