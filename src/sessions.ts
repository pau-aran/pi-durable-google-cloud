import type { HarnessOptions } from "@earendil-works/pi-durable";
import type { WebSocket } from "ws";

export type SessionsOptions = {
  /** Holds `sessions/<id>.sqlite` and `wakes.sqlite`. Only this process may write it. */
  dataDir: string;
  /** Options for the Harness of one session. `onWake` and `onReport` are set by the session. */
  harness: () => HarnessOptions;
};

/** Every session of this process: one open Harness for each id in use, and the wake index that reopens the rest. */
export type Sessions = {
  /** Attach an accepted socket to session `id`, which the caller has checked against `SESSION_ID_PATTERN`. */
  connect(id: string, socket: WebSocket): Promise<void>;
  /** Close every open session. Work in flight stays stored and resumes at the next open. */
  close(): Promise<void>;
};

/** Open the session directory and resume each session whose wake is due. */
export function openSessions(_options: SessionsOptions): Promise<Sessions> {
  throw new Error("Not implemented");
}
