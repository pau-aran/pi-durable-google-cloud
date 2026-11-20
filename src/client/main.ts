import type { LiveState, TranscriptItem } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { SESSION_ID_PATTERN, type ServerMessage } from "../protocol.ts";
import { ChatState } from "./state.ts";
import "./style.css";

const MAX_BACKOFF_MS = 30_000;

function element(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function clip(text: string): string {
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** One message in compact form: user and assistant text, tool calls, and tool results. */
function renderMessage(message: Message): HTMLElement[] {
  if (message.role === "user") {
    const text = typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    return [element("div", "user", text)];
  }
  if (message.role === "toolResult") {
    const text = message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    return [element("div", message.isError ? "tool error" : "tool", clip(`← ${message.toolName}: ${text}`))];
  }
  if (message.role !== "assistant") return [];
  const nodes = message.content.flatMap((part) => {
    if (part.type === "text") return [element("div", "assistant", part.text)];
    if (part.type === "toolCall") return [element("div", "tool", clip(`→ ${part.name} ${JSON.stringify(part.arguments)}`))];
    return [];
  });
  if (message.errorMessage) nodes.push(element("div", "error", message.errorMessage));
  return nodes;
}

function renderItem(item: TranscriptItem): HTMLElement[] {
  if (item.kind === "earlier") return [element("div", "marker", "Earlier messages are not shown.")];
  if (item.kind === "gap") return [element("div", "marker", "Some messages are not shown.")];
  return (item.entry.model ?? []).flatMap(renderMessage);
}

/** The streamed partial answer, the running tool calls, and a run failure. */
function renderLive(live: LiveState | undefined): HTMLElement[] {
  if (!live) return [];
  const nodes = live.generation?.message ? renderMessage(live.generation.message as Message) : [];
  for (const slot of live.tools ?? []) {
    if (slot.status !== "done") nodes.push(element("div", "tool", `${slot.name}: ${slot.status}…`));
  }
  if (live.runFailure) {
    const { reason, detail } = live.runFailure;
    nodes.push(element("div", "error", `The answer failed (${reason})${detail ? `: ${detail}` : ""}`));
  }
  return nodes;
}

function showHome(): void {
  const page = element("div", "home");
  const button = element("button", "", "New chat") as HTMLButtonElement;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await fetch("/api/sessions", { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { sessionId } = (await response.json()) as { sessionId: string };
      location.assign(`/s/${sessionId}`);
    } catch (error) {
      button.disabled = false;
      button.textContent = `New chat (failed: ${String(error)})`;
    }
  };
  page.append(button);
  document.body.append(page);
}

function showChat(sessionId: string): void {
  const state = new ChatState();
  const status = element("header", "", "Connecting…");
  const transcript = element("main", "");
  const form = document.createElement("form");
  const input = document.createElement("textarea");
  input.placeholder = "Message";
  form.append(input, element("button", "", "Send"));
  const page = element("div", "chat");
  page.append(status, transcript, form);
  document.body.append(page);

  const render = () => {
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    const nodes = state.shown ? state.shown.items.flatMap(renderItem) : [];
    nodes.push(...renderLive(state.shown?.docs["pi.live"] as LiveState | undefined));
    if (state.error) nodes.push(element("div", "error", state.error));
    transcript.replaceChildren(...nodes);
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  };

  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/sessions/${sessionId}`;
  let socket: WebSocket | undefined;
  let failures = 0;
  const connect = () => {
    const next = new WebSocket(url);
    next.onopen = () => {
      failures = 0;
      socket = next;
      status.textContent = "Connected";
      for (const message of state.unanswered()) next.send(JSON.stringify(message));
    };
    next.onmessage = (event) => {
      state.receive(JSON.parse(event.data as string) as ServerMessage);
      render();
    };
    next.onclose = () => {
      socket = undefined;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** failures++);
      status.textContent = `Disconnected. Connecting again in ${Math.round(delay / 1000)} s…`;
      setTimeout(connect, delay);
    };
  };
  connect();

  form.onsubmit = (event) => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    const message = state.prompt(content, crypto.randomUUID());
    if (message) {
      input.value = "";
      socket?.send(JSON.stringify(message));
    }
    render();
  };
}

const sessionId = location.pathname.match(/^\/s\/([^/]+)$/)?.[1];
if (sessionId && SESSION_ID_PATTERN.test(sessionId)) showChat(sessionId);
else showHome();
