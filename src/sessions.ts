import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HarnessOptions, Wake } from "@earendil-works/pi-durable";
import type { WebSocket } from "ws";
import { openSession, type Session } from "./session.ts";

/** While a session works, its wake row is at most this far in the future, so a lost process is opened again. */
const HEARTBEAT_MS = 60_000;

/** The longest delay of `setTimeout`. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export type SessionsOptions = {
  /** Holds `sessions/<id>.sqlite` and `wakes.sqlite`. Only this process may write it. */
  dataDir: string;
  /** Options for the Harness of one session. `onWake` and `onReport` are set by the session. */
  harness: () => HarnessOptions;
  /** The clock of the wake index, epoch milliseconds; default `Date.now`. For tests. */
  now?: () => number;
  /** Arms the one timer of the wake index and returns a function that disarms it; default `setTimeout`. For tests. */
  setTimer?: (callback: () => void, delayMs: number) => () => void;
};

/** Every session of this process: one open Harness for each id in use, and the wake index that reopens the rest. */
export type Sessions = {
  /** Attach an accepted socket to session `id`, which the caller has checked against `SESSION_ID_PATTERN`. */
  connect(id: string, socket: WebSocket): Promise<void>;
  /** Close every open session. Work in flight stays stored and resumes at the next open. */
  close(): Promise<void>;
};

/** Open the session directory and resume each session whose wake is due. */
export async function openSessions(options: SessionsOptions): Promise<Sessions> {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  mkdirSync(join(options.dataDir, "sessions"), { recursive: true });
  const wakes = new DatabaseSync(join(options.dataDir, "wakes.sqlite"));
  wakes.exec("CREATE TABLE IF NOT EXISTS wakes (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  const sessions = new Map<string, Session>();
  let disarm: (() => void) | undefined;
  let closed = false;

  /** Arm the one timer for the earliest row. */
  const schedule = (): void => {
    disarm?.();
    disarm = undefined;
    const at = wakes.prepare("SELECT MIN(at) AS at FROM wakes").get()?.at;
    if (closed || typeof at !== "number") return;
    disarm = setTimer(due, Math.min(Math.max(at - now(), 0), MAX_TIMER_MS));
  };

  /** The wake rule: a heartbeat while work runs, never later than the earliest sleep. */
  const arm = (id: string, wake: Wake): void => {
    const heartbeat = wake.active ? now() + HEARTBEAT_MS : undefined;
    const at = heartbeat === undefined || wake.at === undefined ? (heartbeat ?? wake.at) : Math.min(heartbeat, wake.at);
    if (at === undefined) wakes.prepare("DELETE FROM wakes WHERE session_id = ?").run(id);
    else
      wakes
        .prepare("INSERT INTO wakes (session_id, at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET at = excluded.at")
        .run(id, Math.ceil(at));
    schedule();
  };

  /** Move the row of `id` out of the past and to at most one heartbeat from now, so a failed open is tried again. */
  const armBeforeOpen = (id: string): void => {
    wakes
      .prepare(
        "INSERT INTO wakes (session_id, at) VALUES (?1, ?2) " +
          "ON CONFLICT(session_id) DO UPDATE SET at = excluded.at WHERE at <= ?3 OR at > excluded.at",
      )
      .run(id, now() + HEARTBEAT_MS, now());
    schedule();
  };

  const open = (id: string): Session => {
    armBeforeOpen(id);
    const session = openSession({
      id,
      file: join(options.dataDir, "sessions", `${id}.sqlite`),
      harness: options.harness,
      arm: (wake) => arm(id, wake),
    });
    sessions.set(id, session);
    void session.closed.then(() => sessions.delete(id));
    return session;
  };

  function due(): void {
    disarm = undefined;
    for (const row of wakes.prepare("SELECT session_id FROM wakes WHERE at <= ?").all(now())) {
      const id = String(row.session_id);
      const session = sessions.get(id);
      if (session === undefined) open(id);
      else {
        armBeforeOpen(id);
        session.wake();
      }
    }
    schedule();
  }

  schedule();

  return {
    async connect(id, socket) {
      for (;;) {
        const session = sessions.get(id) ?? open(id);
        if (session.attach(socket)) return;
        await session.closed;
      }
    },
    async close() {
      closed = true;
      schedule();
      await Promise.all([...sessions.values()].map((session) => session.close()));
      wakes.close();
    },
  };
}
