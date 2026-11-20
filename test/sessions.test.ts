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
let closeSessions: (() => Promise<void>) | undefined;
/** How many times a session asked for its Harness options: one for each open. */
let opens: number;
let faux: ReturnType<typeof fauxProvider>;
let harness: () => HarnessOptions;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sessions-test-"));
  closeSessions = undefined;
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
  await closeSessions?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true });
});

async function open(options: Partial<SessionsOptions> = {}): Promise<void> {
  sessions = await openSessions({ dataDir, harness: () => harness(), ...options });
  closeSessions = sessions.close;
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

test("an oversized wake arms a timer at boot and shutdown does not query the index", async () => {
  using wakes = new DatabaseSync(join(dataDir, "wakes.sqlite"));
  wakes.exec("CREATE TABLE wakes (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  wakes.prepare("INSERT INTO wakes VALUES (?, ?)").run(ID, 2n ** 53n + 1n);
  const delays: number[] = [];

  await open({
    setTimer: (_callback, delay) => {
      delays.push(delay);
      return () => {};
    },
  });
  expect(delays).toEqual([2 ** 31 - 1]);

  // This lock would make a SELECT on the host's connection fail.
  wakes.exec("BEGIN EXCLUSIVE");
  await sessions.close();
  closeSessions = undefined;
});

test("a failed session commit closes the socket without acknowledging the prompt", async () => {
  faux.setResponses([fauxAssistantMessage("Recovered.")]);
  await open();
  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);
  using db = new DatabaseSync(join(dataDir, "sessions", `${ID}.sqlite`));
  db.exec("CREATE TRIGGER fail_prompt BEFORE INSERT ON entries BEGIN SELECT RAISE(ABORT, 'session write failed'); END");
  const prompt: ClientMessage = { type: "prompt", requestId: "retry", content: "Hello" };

  browser.send(prompt);

  expect(await browser.closed).toBe(1011);
  expect(browser.frames.map((frame) => frame.type)).toEqual(["view"]);
  db.exec("DROP TRIGGER fail_prompt");
  const retry = await connect();
  await retry.until(() => retry.frames.length > 0);
  retry.send(prompt);
  await retry.shows("Recovered.");
  expect(retry.frames).toContainEqual({ type: "result", requestId: "retry", ok: true });
  expect(retry.entries("pi.user")).toHaveLength(1);
});

test("a failed wake-index update logs once and retries the due row after a delay", async () => {
  let timer: { callback: () => void; delay: number } | undefined;
  const now = 100_000;
  await open({
    now: () => now,
    setTimer: (callback, delay) => {
      timer = { callback, delay };
      return () => { timer = undefined; };
    },
  });
  using wakes = new DatabaseSync(join(dataDir, "wakes.sqlite"));
  wakes.prepare("INSERT INTO wakes VALUES (?, ?)").run(ID, now);
  const browser = await connect("00000000-0000-4000-8000-000000000002");
  await browser.until(() => browser.frames.length > 0);
  wakes.exec("CREATE TRIGGER fail_wake BEFORE UPDATE ON wakes BEGIN SELECT RAISE(ABORT, 'wake write failed'); END");
  expect(timer?.delay).toBe(0);
  const stderr = process.stderr.write;
  const lines: string[] = [];
  process.stderr.write = (line: string) => lines.push(line) > 0;
  try {
    timer?.callback();
  } finally {
    process.stderr.write = stderr;
    wakes.exec("DROP TRIGGER fail_wake");
  }

  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^[^\n]+\n$/);
  expect(JSON.parse(lines.join(""))).toEqual({ kind: "wake_timer_failed", error: "Error: wake write failed" });
  expect(timer?.delay).toBeGreaterThan(0);
  expect(timer?.delay).toBeLessThanOrEqual(60_000);
  timer?.callback();
  await eventually(() => wakeRows().length === 0);
  expect(opens).toBe(2);
});

test("shutdown rejects a connect waiting for the previous Harness to close", async () => {
  await open();
  const first = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);
  server.removeAllListeners("connection");
  const second = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const waiting = await connect();
  const firstSocket = await first;
  const secondSocket = await second;
  const result = new Promise<PromiseSettledResult<void>[]>((resolve) => {
    firstSocket.once("close", () => {
      // The session's close listener has started to close the idle Harness.
      const late = sessions.connect(ID, secondSocket);
      const shutdown = sessions.close();
      closeSessions = () => shutdown;
      resolve(Promise.allSettled([late, shutdown]));
    });
  });

  await browser.close();
  const [late, shutdown] = await result;
  await waiting.close();
  expect(shutdown).toMatchObject({ status: "fulfilled" });
  expect(late).toMatchObject({ status: "rejected", reason: { message: "Sessions are closed" } });
  expect(opens).toBe(1);
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

test("an entries request returns the entries before the view's window", async () => {
  const turns = 30;
  faux.setResponses(Array.from({ length: turns }, (_, index) => fauxAssistantMessage(`Answer ${index}.`)));
  await open();
  const writer = await connect();
  for (let index = 0; index < turns; index++) {
    writer.send({ type: "prompt", requestId: `r${index}`, content: `Question ${index}` });
    await writer.shows(`Answer ${index}.`);
  }
  await writer.close();

  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);
  const { view } = browser.frames[0] as Extract<ServerMessage, { type: "view" }>;
  expect(view.before).toBeDefined();
  browser.send({ type: "entries", requestId: "e1", maxEntryId: view.before, limit: 100 });
  await browser.until(() => browser.frames.length > 1);

  const answer = browser.frames[1] as Extract<ServerMessage, { type: "entries" }>;
  expect(answer).toMatchObject({ type: "entries", requestId: "e1" });
  expect(answer.entries[0]!.id).toBe(view.before);
  expect(answer.entries.length + view.entries.length).toBe(2 * turns);
  expect(JSON.stringify(answer.entries.at(-1))).toContain("Question 0");

  // A gap is filled oldest first, from the entry after its start.
  browser.send({ type: "entries", requestId: "e2", minEntryId: answer.entries.at(-1)!.id + 1, order: "ascending", limit: 2 });
  await browser.until(() => browser.frames.length > 2);

  const page = browser.frames[2] as Extract<ServerMessage, { type: "entries" }>;
  expect(page.entries.map((entry) => entry.id)).toEqual([answer.entries.at(-2)!.id, answer.entries.at(-3)!.id]);
});

test("an entries request with a limit out of range closes the socket", async () => {
  await open();
  const browser = await connect();
  await browser.until(() => browser.frames.length > 0);

  browser.send(JSON.stringify({ type: "entries", requestId: "e1", limit: 101 }));

  expect(await browser.closed).toBe(1002);
});
