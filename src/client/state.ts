import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView,
  type EntryRecord,
  type TranscriptItem,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import { type ClientMessage, MAX_CLIENT_FRAME_CHARACTERS, type ServerMessage } from "../protocol.ts";

type Prompt = Extract<ClientMessage, { type: "prompt" }>;
type Gap = Extract<TranscriptItem, { kind: "gap" }>;

/** The key of a gap in `ChatSnapshot.filling`. */
export const gapKey = (gap: Gap): string => `gap-${gap.after}`;

/** What the page renders. A new object after each change, so React can compare snapshots by identity. */
export type ChatSnapshot = {
  /** The transcript and the documents of the conversation; undefined until the first `view`. */
  readonly shown: TranscriptView | undefined;
  /** The newest prompt error, cleared by the next prompt. */
  readonly error: string | undefined;
  /** Entries before the first item exist (`more`) or are on their way (`loading`); undefined at the start. */
  readonly earlier: "more" | "loading" | undefined;
  /** The gaps whose entries are on their way, by `gapKey`. */
  readonly filling: ReadonlySet<string>;
};

/**
 * The browser's side of one session, without the DOM: the last view, the transcript the page renders, and the prompts
 * the server has not answered yet. `send` writes one frame to the socket and returns `false` when there is none.
 */
export class ChatState {
  readonly #send: (message: ClientMessage) => boolean;
  #view: ConversationView | undefined;
  readonly #transcript = new ConversationTranscript(async (query, limit) => ({ items: await this.#entries(query, limit) }));
  readonly #unanswered = new Map<string, Prompt>();
  readonly #entryRequests = new Map<string, PromiseWithResolvers<readonly EntryRecord[]>>();
  readonly #listeners = new Set<() => void>();
  #loadingEarlier = false;
  #filling: ReadonlySet<string> = new Set();
  #shown: TranscriptView | undefined;
  #error: string | undefined;
  #requests = 0;

  snapshot: ChatSnapshot = { shown: undefined, error: undefined, earlier: undefined, filling: this.#filling };

  constructor(send: (message: ClientMessage) => boolean = () => false) {
    this.#send = send;
  }

  /** Call `listener` after each change of `snapshot`. Returns a function that removes it. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #changed(): void {
    const earlier = this.#shown?.items[0]?.kind !== "earlier" ? undefined : this.#loadingEarlier ? "loading" : "more";
    this.snapshot = { shown: this.#shown, error: this.#error, earlier, filling: this.#filling };
    for (const listener of [...this.#listeners]) listener();
  }

  #entries(query: Omit<Extract<ClientMessage, { type: "entries" }>, "type" | "requestId" | "limit">, limit: number) {
    const requestId = `entries-${++this.#requests}`;
    if (!this.#send({ type: "entries", requestId, ...query, limit })) return Promise.reject(new Error("Not connected."));
    const request = Promise.withResolvers<readonly EntryRecord[]>();
    this.#entryRequests.set(requestId, request);
    return request.promise;
  }

  /** Queue a prompt until its `result`. Returns undefined, and sets the error, when its frame is too large to send. */
  prompt(content: string, requestId: string): Prompt | undefined {
    const message: Prompt = { type: "prompt", requestId, content };
    const fits = JSON.stringify(message).length <= MAX_CLIENT_FRAME_CHARACTERS;
    this.#error = fits ? undefined : "The message is too long.";
    if (fits) this.#unanswered.set(requestId, message);
    this.#changed();
    return fits ? message : undefined;
  }

  /** Every prompt without a `result`, oldest first, to send again after a reconnect. */
  unanswered(): Prompt[] {
    return [...this.#unanswered.values()];
  }

  /** Drop the error that `snapshot` shows. */
  dismissError(): void {
    this.#error = undefined;
    this.#changed();
  }

  /** Load the page of entries before the first one shown. A failed load leaves `earlier` at `more`. */
  async loadEarlier(): Promise<void> {
    if (this.#loadingEarlier) return;
    this.#loadingEarlier = true;
    this.#changed();
    this.#shown = await this.#transcript.loadEarlier(context).catch(() => this.#shown);
    this.#loadingEarlier = false;
    this.#changed();
  }

  /** Load the next page of the entries that `gap` stands for. A failed load leaves the gap. */
  async fillGap(gap: Gap): Promise<void> {
    const key = gapKey(gap);
    if (this.#filling.has(key)) return;
    this.#filling = new Set(this.#filling).add(key);
    this.#changed();
    this.#shown = await this.#transcript.fillGap(gap, context).catch(() => this.#shown);
    const filling = new Set(this.#filling);
    filling.delete(key);
    this.#filling = filling;
    this.#changed();
  }

  /** The socket closed: its `entries` requests get no answer. */
  disconnected(): void {
    for (const request of this.#entryRequests.values()) request.reject(new Error("Not connected."));
    this.#entryRequests.clear();
  }

  receive(message: ServerMessage): void {
    if (message.type === "entries" || message.type === "result") {
      const request = this.#entryRequests.get(message.requestId);
      this.#entryRequests.delete(message.requestId);
      if (message.type === "entries") return request?.resolve(message.entries);
      if (request) return request.reject(new Error(message.ok ? "No entries." : message.error));
      this.#unanswered.delete(message.requestId);
      if (!message.ok) this.#error = message.error;
    } else {
      this.#view = message.type === "view" ? message.view : applyImmutable(this.#view, message.ops);
      this.#shown = this.#transcript.merge(this.#view);
    }
    this.#changed();
  }
}
