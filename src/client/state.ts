import { applyImmutable } from "@earendil-works/chord/delta";
import { ConversationTranscript, type ConversationView, type TranscriptView } from "@earendil-works/pi-durable";
import { type ClientMessage, MAX_CLIENT_FRAME_CHARACTERS, type ServerMessage } from "../protocol.ts";

/**
 * The browser's side of one session, without the DOM: the last view, the transcript the page renders, and the prompts
 * the server has not answered yet.
 */
export class ChatState {
  #view: ConversationView | undefined;
  // The protocol has no route to fetch entries, so "earlier" and gap items stay as markers.
  readonly #transcript = new ConversationTranscript(() => Promise.reject(new Error("The server has no entry route.")));
  readonly #unanswered = new Map<string, ClientMessage>();

  /** What the page renders; undefined until the first `view`. */
  shown: TranscriptView | undefined;
  /** The newest prompt error, cleared by the next prompt. */
  error: string | undefined;

  /** Queue a prompt until its `result`. Returns undefined, and sets `error`, when its frame is too large to send. */
  prompt(content: string, requestId: string): ClientMessage | undefined {
    const message: ClientMessage = { type: "prompt", requestId, content };
    if (JSON.stringify(message).length > MAX_CLIENT_FRAME_CHARACTERS) {
      this.error = "The message is too long.";
      return undefined;
    }
    this.error = undefined;
    this.#unanswered.set(requestId, message);
    return message;
  }

  /** Every prompt without a `result`, oldest first, to send again after a reconnect. */
  unanswered(): ClientMessage[] {
    return [...this.#unanswered.values()];
  }

  receive(message: ServerMessage): void {
    if (message.type === "result") {
      this.#unanswered.delete(message.requestId);
      if (!message.ok) this.error = message.error;
      return;
    }
    this.#view = message.type === "view" ? message.view : applyImmutable(this.#view, message.ops);
    this.shown = this.#transcript.merge(this.#view);
  }
}
