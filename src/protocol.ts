import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";

/** A session id is a lowercase UUID. It names a file on disk, so the server checks it before any other use. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A frame longer than this closes the socket with code 1009. */
export const MAX_CLIENT_FRAME_CHARACTERS = 64_000;

/** Browser to server, one JSON text frame each. A resent `requestId` does not submit the prompt twice. */
export type ClientMessage = { type: "prompt"; requestId: string; content: string };

/**
 * Server to browser, one JSON text frame each.
 *
 * - `view`: the root conversation at attachment. It is the first frame on every socket.
 * - `ops`: the Chord operations that turn the last view into the next (`applyImmutable` from `chord/delta`).
 * - `result`: the answer to one `prompt`. `ok` means the prompt is stored, not that the model answered.
 */
export type ServerMessage =
  | { type: "view"; view: ConversationView }
  | { type: "ops"; ops: readonly Op[] }
  | { type: "result"; requestId: string; ok: true }
  | { type: "result"; requestId: string; ok: false; error: string };
