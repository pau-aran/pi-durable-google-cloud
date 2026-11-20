import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  type HarnessOptions,
  section,
} from "@earendil-works/pi-durable";

/** Sleeps until `at`, then submits `text` to its conversation as a new input. The sleep is stored, so it survives a restart. */
const ReminderTask = defineTask<{ text: string; at: number }, { phase: "wait" } | { phase: "deliver" }, null>({
  name: "chat.reminder",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: (task, runtime, context) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
    deliver: async (task, runtime, context) => {
      const conversation = (await runtime.conversation(runtime.conversationId, context))!;
      await runtime.commit(async (tx) => {
        await conversation.submit(tx, { type: "input", content: `Reminder: ${task.input.text}` });
        return { status: "terminal", outcome: { status: "completed", result: null } };
      }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

const MAX_REMINDER_SECONDS = 365 * 24 * 60 * 60;

const remindTool = defineTool({
  name: "remind",
  description: "Send a text to this conversation as a new user input after a delay.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to deliver." },
      seconds: { type: "number", minimum: 0, description: "The delay in seconds, at most one year." },
    },
    required: ["text", "seconds"],
    additionalProperties: false,
  },
  execute: async (args, api, context) => {
    const { text, seconds } = args as { text: string; seconds: number };
    if (seconds > MAX_REMINDER_SECONDS) {
      return { output: [{ type: "text", text: `The delay is at most ${MAX_REMINDER_SECONDS} s (one year).` }], isError: true };
    }
    await api.createTask(
      ReminderTask,
      { text, at: api.now() + seconds * 1000 },
      { ownership: { kind: "conversation" }, background: true },
      context,
    );
    return { output: [{ type: "text", text: `Reminder set for ${seconds} s from now.` }] };
  },
});

const Chat = defineExtension({
  name: "chat",
  tools: [remindTool],
  tasks: [ReminderTask],
  sections: [
    section(
      "preamble",
      () =>
        "You are a concise assistant. Use the `remind` tool when the user asks to be reminded of something later. " +
        "An input that starts with `Reminder:` is a reminder that came due: pass it on to the user.",
      { tag: false },
    ),
  ],
});

/** The agent of this sample: its models, tools, and system prompt. It knows nothing about the host. */
export function createChatHarnessOptions(): HarnessOptions {
  const models = createModels();
  models.setProvider(openaiProvider());
  const registry = createRegistry();
  registry.install(Chat);
  return {
    models,
    registry,
    // A follow-up queued behind a failed answer runs at once. With the default, it waits for another input with no wake row.
    settings: { afterFailedRun: "continue" },
    conversationCreated: (tx, conversation) =>
      configure(tx, conversation.id, { model: { provider: "openai", modelId: "gpt-6.1-sol" } }),
  };
}
