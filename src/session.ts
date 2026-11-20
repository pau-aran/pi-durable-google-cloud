import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type Conversation, type ConversationView, Harness, type HarnessOptions, type Wake } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { RawData, WebSocket } from "ws";
import { type ClientMessage, MAX_CLIENT_FRAME_CHARACTERS, type ServerMessage } from "./protocol.ts";

/** One open Harness, the sockets that watch its root conversation, and its row in the wake index. */
export type Session = {
  /** Attach `socket`. `false`: the session is closing, so the caller opens a new one after `closed`. */
  attach(socket: WebSocket): boolean;
  /** The wake row of this session is due. */
  wake(): void;
  /** Close the sockets and the Harness. */
  close(): Promise<void>;
  /** Settles when the Harness has closed and its file is free for the next open. */
  readonly closed: Promise<void>;
};

type SessionOptions = {
  id: string;
  /** The SQLite file of the session. */
  file: string;
  harness: () => HarnessOptions;
  /** Write the next wake of this session to the index. A throw closes the session. */
  arm: (wake: Wake) => void;
};

/** Write one JSON line about session `id` to stderr. */
function log(id: string, fields: object, error: unknown): void {
  process.stderr.write(`${JSON.stringify({ sessionId: id, ...fields, error: String(error) })}\n`);
}

function parse(text: string): ClientMessage | undefined {
  try {
    const message: unknown = JSON.parse(text);
    if (typeof message !== "object" || message === null) return undefined;
    const { type, requestId, content } = message as Record<string, unknown>;
    if (type === "prompt" && typeof requestId === "string" && typeof content === "string") return { type, requestId, content };
  } catch {}
  return undefined;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

/** Start to open session `id`. Sockets attach at once and get their `view` when the Harness is open. */
export function openSession({ id, file, harness: harnessOptions, arm }: SessionOptions): Session {
  const sockets = new Set<WebSocket>();
  const closed = Promise.withResolvers<void>();
  let closing = false;
  let harness: Harness | undefined;
  /** Set when the open is complete. */
  let open: { harness: Harness; root: Conversation; view: ConversationView } | undefined;

  const close = async (code: number): Promise<void> => {
    if (closing) return closed.promise;
    closing = true;
    for (const socket of sockets) socket.close(code);
    await opened;
    // A failed Harness has closed itself.
    await harness?.close(context).catch(() => {});
    closed.resolve();
  };

  /** Write a wake. `false`: the write failed and the session closes. */
  const armed = (wake: Wake): boolean => {
    try {
      arm(wake);
      return true;
    } catch (error) {
      log(id, { kind: "wake_write_failed" }, error);
      void close(1011);
      return false;
    }
  };

  /** Close when no socket and no work is left. The wake row stays, and its timer opens the session again. */
  const settle = (): void => {
    if (open !== undefined && !closing && sockets.size === 0 && !open.harness.wake().active) void close(1001);
  };

  /** Run due sleeps and the work that a lost process left. */
  const resume = ({ harness } = open!): void => {
    if (!armed({ ...harness.wake(), active: true })) return;
    harness.resume();
    if (armed(harness.wake())) settle();
  };

  const opened = (async () => {
    harness = await Harness.open(
      await openNodeSqliteStorage(file),
      {
        ...harnessOptions(),
        // Until `resume()` has run, the row that the caller armed before this open stays.
        onWake: (wake) => void (open !== undefined && !closing && armed(wake) && settle()),
        onReport: ({ error, ...report }) => log(id, report, error),
      },
      context,
    );
    void harness.closed.then((end) => void (end.kind === "failed" && close(1011)));
    const root = await harness.root(context);
    const watch = await root.watch(context);
    const session = { harness, root, view: watch.value };
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      session.view = call.value;
      for (const socket of sockets) send(socket, { type: "ops", ops: call.ops });
    });
    open = session;
    if (closing) return;
    for (const socket of sockets) send(socket, { type: "view", view: session.view });
    resume();
  })().catch((error: unknown) => {
    log(id, { kind: "open_failed" }, error);
    void close(1011);
  });

  const prompt = async (socket: WebSocket, { requestId, content }: ClientMessage): Promise<void> => {
    await opened;
    if (open === undefined || closing) return;
    try {
      if (!armed({ ...open.harness.wake(), active: true })) return;
      await open.root.submit({ type: "input", content, requestId, whenBusy: "followUp" }, context);
      send(socket, { type: "result", requestId, ok: true });
    } catch (error) {
      send(socket, { type: "result", requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    attach(socket) {
      if (closing) return false;
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
        settle();
      });
      socket.on("error", () => socket.terminate());
      socket.on("message", (data: RawData, isBinary: boolean) => {
        const text = data.toString();
        if (text.length > MAX_CLIENT_FRAME_CHARACTERS) return socket.close(1009);
        const message = isBinary ? undefined : parse(text);
        if (message === undefined) return socket.close(1002);
        void prompt(socket, message);
      });
      if (open !== undefined) send(socket, { type: "view", view: open.view });
      return true;
    },
    wake() {
      if (open !== undefined && !closing) resume();
    },
    close: () => close(1001),
    closed: closed.promise,
  };
}
