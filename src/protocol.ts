import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, EntryRecord } from "@earendil-works/pi-durable";

/** A session id is a lowercase UUID. It names a file on disk, so the server checks it before any other use. */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A frame longer than this closes the socket with code 1009. */
export const MAX_CLIENT_FRAME_CHARACTERS = 64_000;

/** The most entries one `entries` request returns. */
export const MAX_ENTRIES_LIMIT = 100;

/**
 * Browser to server, one JSON text frame each.
 *
 * - `prompt`: a resent `requestId` does not submit the prompt twice.
 * - `entries`: entries that the view's window does not hold, with IDs from `minEntryId` to `maxEntryId` (both inclusive
 *   and optional), newest first unless `order` is `ascending`, at most `limit` (1 to `MAX_ENTRIES_LIMIT`).
 */
export type ClientMessage =
  | { type: "prompt"; requestId: string; content: string }
  | { type: "entries"; requestId: string; minEntryId?: number; maxEntryId?: number; order?: "ascending" | "descending"; limit: number };

/**
 * Server to browser, one JSON text frame each.
 *
 * - `view`: the root conversation at attachment. It is the first frame on every socket.
 * - `ops`: the Chord operations that turn the last view into the next (`applyImmutable` from `chord/delta`).
 * - `result`: the answer to one `prompt`, where `ok` means the prompt is stored, not that the model answered. Also the
 *   answer to an `entries` request that failed.
 * - `entries`: the answer to one `entries` request.
 */
export type ServerMessage =
  | { type: "view"; view: ConversationView }
  | { type: "ops"; ops: readonly Op[] }
  | { type: "entries"; requestId: string; entries: readonly EntryRecord[] }
  | { type: "result"; requestId: string; ok: true }
  | { type: "result"; requestId: string; ok: false; error: string };
