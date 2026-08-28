import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CANCEL,
  COMPACT_AND_SEND,
  createPiIdleCheck,
  SEND_WITHOUT_COMPACTING,
} from "../index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CompactOptions = Parameters<ExtensionContext["compact"]>[0];
type SendContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type SendOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];

type Harness = {
  handlers: Map<string, Handler[]>;
  sends: Array<{ content: SendContent; options: SendOptions }>;
  setNow(value: number): void;
  emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown>;
};

type ContextHarness = {
  ctx: ExtensionContext;
  compactOptions: CompactOptions;
  editorText: string;
  notifications: Array<{ message: string; type: string | undefined }>;
  selectCalls: number;
  terminalHandler: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
  setIdle(value: boolean): void;
};

function assistantEntry(timestamp: number): SessionEntry {
  return {
    type: "message",
    id: `assistant-${timestamp}`,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: "assistant" },
  } as unknown as SessionEntry;
}

function inputEvent(
  text: string,
  options: {
    source?: "interactive" | "rpc" | "extension";
    streamingBehavior?: "steer" | "followUp";
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
  } = {},
): unknown {
  return {
    type: "input",
    text,
    source: options.source ?? "interactive",
    ...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
    ...(options.images === undefined ? {} : { images: options.images }),
  };
}

function createHarness(initialNow = 0): Harness {
  let currentNow = initialNow;
  const handlers = new Map<string, Handler[]>();
  const sends: Harness["sends"] = [];
  const api = {
    on(event: string, handler: Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    sendUserMessage(content: SendContent, options: SendOptions) {
      sends.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  createPiIdleCheck({ now: () => currentNow })(api);

  return {
    handlers,
    sends,
    setNow(value) {
      currentNow = value;
    },
    async emit(event, payload, ctx) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
      return result;
    },
  };
}

function createContext(
  entries: SessionEntry[],
  choices: Array<string | undefined | Error> = [],
  options: { mode?: ExtensionContext["mode"]; hasUI?: boolean; idle?: boolean; editorText?: string } = {},
): ContextHarness {
  let idle = options.idle ?? true;
  let editorText = options.editorText ?? "";
  let compactOptions: CompactOptions;
  let selectCalls = 0;
  let terminalHandler: ContextHarness["terminalHandler"];
  const notifications: ContextHarness["notifications"] = [];

  const ui = {
    async select() {
      selectCalls++;
      const choice = choices.shift();
      if (choice instanceof Error) throw choice;
      return choice;
    },
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
    onTerminalInput(handler: ContextHarness["terminalHandler"]) {
      terminalHandler = handler;
      return () => {
        terminalHandler = undefined;
      };
    },
    getEditorText() {
      return editorText;
    },
    setEditorText(text: string) {
      editorText = text;
    },
  } as unknown as ExtensionUIContext;

  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const ctx = {
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui,
    sessionManager: {
      getLeafEntry: () => entries.at(-1),
      getEntry: (id: string) => entriesById.get(id),
    },
    isIdle: () => idle,
    compact(value: CompactOptions) {
      compactOptions = value;
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    get compactOptions() {
      return compactOptions;
    },
    get editorText() {
      return editorText;
    },
    notifications,
    get selectCalls() {
      return selectCalls;
    },
    get terminalHandler() {
      return terminalHandler;
    },
    setIdle(value) {
      idle = value;
    },
  };
}

async function start(harness: Harness, context: ContextHarness): Promise<void> {
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, context.ctx);
}

test("registers only the idle lifecycle and input handlers", () => {
  const harness = createHarness();
  assert.deepEqual([...harness.handlers.keys()].sort(), [
    "agent_settled",
    "agent_start",
    "input",
    "session_compact",
    "session_shutdown",
    "session_start",
  ]);
});

test("extension gate preserves the strict threshold boundary", async () => {
  for (const [elapsed, expectedCalls] of [
    [179_999, 0],
    [180_000, 0],
    [180_001, 1],
  ] as const) {
    const harness = createHarness(elapsed);
    const context = createContext([assistantEntry(0)], [CANCEL]);
    await start(harness, context);
    await harness.emit("input", inputEvent("next"), context.ctx);
    assert.equal(context.selectCalls, expectedCalls, `${elapsed}ms`);
  }
});

test("raw user activity resets before threshold and latches after it", async () => {
  const early = createHarness(179_999);
  const earlyContext = createContext([assistantEntry(0)], [CANCEL]);
  await start(early, earlyContext);
  earlyContext.terminalHandler?.("x");
  early.setNow(180_001);
  await early.emit("input", inputEvent("next"), earlyContext.ctx);
  assert.equal(earlyContext.selectCalls, 0);

  const late = createHarness(180_001);
  const lateContext = createContext([assistantEntry(0)], [CANCEL]);
  await start(late, lateContext);
  lateContext.terminalHandler?.("x");
  late.setNow(180_002);
  await late.emit("input", inputEvent("next"), lateContext.ctx);
  assert.equal(lateContext.selectCalls, 1);
});

test("new, active, streaming, RPC, extension, and non-TUI inputs bypass the dialog", async () => {
  const cases: Array<{
    entries?: SessionEntry[];
    event?: unknown;
    context?: Parameters<typeof createContext>[2];
  }> = [
    { entries: [] },
    { context: { idle: false } },
    { event: inputEvent("next", { streamingBehavior: "steer" }) },
    { event: inputEvent("next", { source: "rpc" }) },
    { event: inputEvent("next", { source: "extension" }) },
    { context: { mode: "print", hasUI: false } },
  ];

  for (const testCase of cases) {
    const harness = createHarness(180_001);
    const context = createContext(testCase.entries ?? [assistantEntry(0)], [CANCEL], testCase.context);
    await start(harness, context);
    const result = await harness.emit("input", testCase.event ?? inputEvent("next"), context.ctx);
    assert.deepEqual(result, { action: "continue" });
    assert.equal(context.selectCalls, 0);
  }
});

test("send choice passes the original input through without invoking compaction", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [SEND_WITHOUT_COMPACTING]);
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("unchanged"), context.ctx);
  assert.deepEqual(result, { action: "continue" });
  assert.equal(context.compactOptions, undefined);
  assert.deepEqual(harness.sends, []);
});

test("cancel handles the input and restores it without overwriting a newer draft", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL], { editorText: "new draft" });
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("original"), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(context.editorText, "original\nnew draft");
  assert.deepEqual(harness.sends, []);
});

test("compact choice withholds then replays exact text and images once", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [COMPACT_AND_SEND]);
  const image = { type: "image" as const, data: "base64", mimeType: "image/png" };
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("/template arg", { images: [image] }), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(harness.sends, []);
  assert.ok(context.compactOptions?.onComplete);

  await harness.emit("session_compact", { type: "session_compact" }, context.ctx);
  context.compactOptions.onComplete?.({} as never);
  assert.deepEqual(harness.sends, [
    {
      content: [{ type: "text", text: "/template arg" }, image],
      options: { expandPromptTemplates: true },
    },
  ]);

  harness.setNow(900_000);
  const recursive = await harness.emit(
    "input",
    inputEvent("/template arg", { source: "extension", images: [image] }),
    context.ctx,
  );
  assert.deepEqual(recursive, { action: "continue" });
  assert.equal(context.selectCalls, 1);
});

test("compaction failure sends nothing, reports error, restores text, and retains the decision", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [COMPACT_AND_SEND, CANCEL]);
  await start(harness, context);

  await harness.emit("input", inputEvent("original"), context.ctx);
  context.compactOptions?.onError?.(new Error("summary unavailable"));
  assert.deepEqual(harness.sends, []);
  assert.equal(context.editorText, "original");
  assert.deepEqual(context.notifications, [
    { message: "Compaction failed; prompt was not sent: summary unavailable", type: "error" },
  ]);

  await harness.emit("input", inputEvent("original"), context.ctx);
  assert.equal(context.selectCalls, 2);
});

test("dialog errors fail closed and restore the prompt", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [new Error("UI unavailable")]);
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("original"), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(context.editorText, "original");
  assert.deepEqual(harness.sends, []);
  assert.match(context.notifications[0]?.message ?? "", /prompt was not sent: UI unavailable/);
});

test("agent and compaction settlement restart the idle interval", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL]);
  await start(harness, context);

  await harness.emit("agent_start", { type: "agent_start" }, context.ctx);
  harness.setNow(900_000);
  await harness.emit("input", inputEvent("during run"), context.ctx);
  assert.equal(context.selectCalls, 0);

  await harness.emit("agent_settled", { type: "agent_settled" }, context.ctx);
  harness.setNow(1_080_000);
  await harness.emit("input", inputEvent("boundary"), context.ctx);
  assert.equal(context.selectCalls, 0);

  await harness.emit("session_compact", { type: "session_compact" }, context.ctx);
  harness.setNow(1_260_001);
  await harness.emit("input", inputEvent("after compact"), context.ctx);
  assert.equal(context.selectCalls, 1);
});

test("shutdown removes terminal listener and clears session state", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL]);
  await start(harness, context);
  assert.ok(context.terminalHandler);

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context.ctx);
  assert.equal(context.terminalHandler, undefined);
  await harness.emit("input", inputEvent("next"), context.ctx);
  assert.equal(context.selectCalls, 0);
});
