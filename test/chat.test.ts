import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, test } from "vitest";
import { createChatHarnessOptions } from "../src/chat.ts";

test("the root conversation gets an OpenAI model and only the remind tool", async () => {
  const harness = await Harness.open(new MemoryStorage(), createChatHarnessOptions(), context);
  const agent = await (await harness.root(context)).agent(context);
  expect(agent.model).toMatchObject({ provider: "openai", modelId: "gpt-6.1-sol" });
  expect(agent.tools.map((tool) => tool.name)).toEqual(["remind"]);
  await harness.close(context);
});

test("MODEL_PROVIDER=google-vertex gives the root conversation a Gemini model on Vertex AI", async () => {
  const env = { MODEL_PROVIDER: "google-vertex", GOOGLE_CLOUD_API_KEY: "test-key" };
  const harness = await Harness.open(new MemoryStorage(), createChatHarnessOptions(env), context);
  const agent = await (await harness.root(context)).agent(context);
  expect(agent.model).toMatchObject({ provider: "google-vertex", modelId: "gemini-4-argon" });
  await harness.close(context);
});

test("MODEL_ID overrides the provider's model", async () => {
  const harness = await Harness.open(new MemoryStorage(), createChatHarnessOptions({ MODEL_ID: "gpt-6.1-terra" }), context);
  const agent = await (await harness.root(context)).agent(context);
  expect(agent.model).toMatchObject({ provider: "openai", modelId: "gpt-6.1-terra" });
  await harness.close(context);
});

test("an unknown MODEL_PROVIDER or a missing Vertex key stops the start", () => {
  expect(() => createChatHarnessOptions({ MODEL_PROVIDER: "gemini" })).toThrow('MODEL_PROVIDER is "gemini"');
  expect(() => createChatHarnessOptions({ MODEL_PROVIDER: "google-vertex" })).toThrow("GOOGLE_CLOUD_API_KEY is not set");
});

test("remind delivers its text as a new input after the delay, across a restart", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  let now = 1_000_000;
  // `onWake` as on the real host: the Harness arms no timer, and the test wakes it.
  const options = { ...createChatHarnessOptions(), models, now: () => now, onWake: () => {} };
  const file = join(mkdtempSync(join(tmpdir(), "chat-")), "session.sqlite");

  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("remind", { text: "drink tea", seconds: 90 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("I will remind you."),
    fauxAssistantMessage("Time to drink tea."),
  ]);

  let harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
  let root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  const submission = await root.submit({ type: "input", content: "Remind me to drink tea in 90 s" }, context);
  expect((await submission.wait(context)).status).toBe("done");
  await harness.waitForIdle(context);
  expect(harness.wake().at).toBe(now + 90_000);
  await harness.close(context);

  harness = await Harness.open(await openNodeSqliteStorage(file), options, context);
  root = await harness.root(context);
  expect(harness.wake().at).toBe(now + 90_000);

  // Not due yet: a wake changes nothing.
  now += 89_000;
  harness.resume();
  await harness.waitForIdle(context);
  expect(faux.state.callCount).toBe(2);

  now += 1_000;
  const [reminder] = (await harness.inspect(context)).tasks;
  harness.resume();
  await harness.waitForTask(reminder!.record.id, context);
  await harness.waitForIdle(context);

  const { messages } = await root.context(context);
  expect(messages.slice(-2)).toMatchObject([
    { role: "user", content: "Reminder: drink tea" },
    { role: "assistant", content: [{ type: "text", text: "Time to drink tea." }] },
  ]);
  expect(harness.wake().at).toBeUndefined();
  await harness.close(context);
});

test("remind refuses a delay longer than one year with an error the model reads", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("remind", { text: "later", seconds: 1e13 }), { stopReason: "toolUse" }),
    fauxAssistantMessage("That is too far away."),
  ]);

  const harness = await Harness.open(new MemoryStorage(), { ...createChatHarnessOptions(), models }, context);
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  await (await root.submit({ type: "input", content: "Remind me much later" }, context)).wait(context);
  await harness.waitForIdle(context);

  const { messages } = await root.context(context);
  expect(messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolName: "remind", isError: true }));
  expect(harness.wake().at).toBeUndefined();
  await harness.close(context);
});

test("a follow-up queued behind a failed answer still runs", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const release = Promise.withResolvers<void>();
  faux.setResponses([
    async () => {
      await release.promise;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "permanent failure" });
    },
    fauxAssistantMessage("second answer"),
  ]);

  const harness = await Harness.open(new MemoryStorage(), { ...createChatHarnessOptions(), models }, context);
  const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  await root.submit({ type: "input", content: "first" }, context);
  await expect.poll(() => faux.state.callCount).toBe(1);
  await root.submit({ type: "input", content: "second", whenBusy: "followUp" }, context);
  release.resolve();
  await expect.poll(() => faux.state.callCount).toBeGreaterThanOrEqual(2);
  await harness.waitForIdle(context);

  const { messages } = await root.context(context);
  expect(messages.at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "second answer" }] });
  await harness.close(context);
});
