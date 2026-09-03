import assert from "node:assert/strict";
import test from "node:test";

import type {
  ContextUsage,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  CANCEL,
  COMPACT_AND_SEND,
  createPiIdleCheck,
  idlePromptChoice,
  NEW_SESSION_AND_SEND,
  NEW_SESSION_COMMAND,
  SEND_WITHOUT_COMPACTING,
  type ContextThreshold,
} from "../index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
type CompactOptions = Parameters<ExtensionContext["compact"]>[0];
type SendContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];
type SendOptions = Parameters<ExtensionAPI["sendUserMessage"]>[1];
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type ReplacementContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];
type DialogComponent = { render(width: number): string[] };
type DialogFactory = (
  tui: unknown,
  theme: { fg(color: string, text: string): string; bold(text: string): string },
  keybindings: unknown,
  done: (choice: string | undefined) => void,
) => DialogComponent | Promise<DialogComponent>;

type Harness = {
  commands: Map<string, CommandHandler>;
  handlers: Map<string, Handler[]>;
  sends: Array<{ content: SendContent; options: SendOptions }>;
  failNextSend(error: Error): void;
  setNow(value: number): void;
  emit(event: string, payload: unknown, ctx: ExtensionContext): Promise<unknown>;
};

type ContextHarness = {
  ctx: ExtensionContext;
  compactOptions: CompactOptions;
  dialogCalls: number;
  dialogLines: string[];
  editorText: string;
  notifications: Array<{ message: string; type: string | undefined }>;
  terminalHandler: Parameters<ExtensionUIContext["onTerminalInput"]>[0] | undefined;
  setIdle(value: boolean): void;
};

const DEFAULT_USAGE: ContextUsage = { tokens: 50_000, contextWindow: 1_000_000, percent: 5 };

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

function createHarness(
  initialNow = 0,
  contextThreshold: ContextThreshold = { unit: "percent", value: 5 },
): Harness {
  let currentNow = initialNow;
  const commands = new Map<string, CommandHandler>();
  const handlers = new Map<string, Handler[]>();
  const sends: Harness["sends"] = [];
  let sendError: Error | undefined;
  const api = {
    on(event: string, handler: Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    sendUserMessage(content: SendContent, options: SendOptions) {
      if (sendError !== undefined) {
        const error = sendError;
        sendError = undefined;
        throw error;
      }
      sends.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  createPiIdleCheck({ now: () => currentNow, contextThreshold })(api);

  return {
    commands,
    handlers,
    sends,
    failNextSend(error) {
      sendError = error;
    },
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
  options: {
    mode?: ExtensionContext["mode"];
    hasUI?: boolean;
    idle?: boolean;
    editorText?: string;
    usage?: ContextUsage | undefined;
  } = {},
): ContextHarness {
  let idle = options.idle ?? true;
  let editorText = options.editorText ?? "";
  let compactOptions: CompactOptions;
  let dialogCalls = 0;
  let dialogLines: string[] = [];
  let terminalHandler: ContextHarness["terminalHandler"];
  const notifications: ContextHarness["notifications"] = [];

  const ui = {
    async custom(factory: DialogFactory) {
      dialogCalls++;
      const component = await factory(
        undefined,
        { fg: (_color, text) => text, bold: (text) => text },
        undefined,
        () => {},
      );
      dialogLines = component.render(200);
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
    cwd: "/project",
    mode: options.mode ?? "tui",
    hasUI: options.hasUI ?? true,
    ui,
    sessionManager: {
      getLeafEntry: () => entries.at(-1),
      getEntry: (id: string) => entriesById.get(id),
    },
    isIdle: () => idle,
    isProjectTrusted: () => true,
    getContextUsage: () => ("usage" in options ? options.usage : DEFAULT_USAGE),
    compact(value: CompactOptions) {
      compactOptions = value;
    },
  } as unknown as ExtensionContext;

  return {
    ctx,
    get compactOptions() {
      return compactOptions;
    },
    get dialogCalls() {
      return dialogCalls;
    },
    get dialogLines() {
      return dialogLines;
    },
    get editorText() {
      return editorText;
    },
    notifications,
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

test("maps Enter, c, C, Escape, and Ctrl-C directly and case-sensitively", () => {
  assert.equal(idlePromptChoice("\r"), SEND_WITHOUT_COMPACTING);
  assert.equal(idlePromptChoice("\n"), SEND_WITHOUT_COMPACTING);
  assert.equal(idlePromptChoice("c"), COMPACT_AND_SEND);
  assert.equal(idlePromptChoice("C"), NEW_SESSION_AND_SEND);
  assert.equal(idlePromptChoice("\x1b[99;2u"), NEW_SESSION_AND_SEND);
  assert.equal(idlePromptChoice("\x1b"), CANCEL);
  assert.equal(idlePromptChoice("\x03"), CANCEL);
  assert.equal(idlePromptChoice("x"), undefined);
});

test("registers the handoff command and only required lifecycle handlers", () => {
  const harness = createHarness();
  assert.deepEqual([...harness.commands.keys()], [NEW_SESSION_COMMAND]);
  assert.deepEqual([...harness.handlers.keys()].sort(), [
    "agent_settled",
    "agent_start",
    "input",
    "session_compact",
    "session_shutdown",
    "session_start",
  ]);
});

test("preserves the strict idle-time boundary", async () => {
  for (const [elapsed, expectedCalls] of [
    [179_999, 0],
    [180_000, 0],
    [180_001, 1],
  ] as const) {
    const harness = createHarness(elapsed);
    const context = createContext([assistantEntry(0)], [CANCEL]);
    await start(harness, context);
    await harness.emit("input", inputEvent("next"), context.ctx);
    assert.equal(context.dialogCalls, expectedCalls, `${elapsed}ms`);
  }
});

test("dialog reports the actual elapsed idle duration", async () => {
  const harness = createHarness(394_999);
  const context = createContext([assistantEntry(0)], [CANCEL]);
  await start(harness, context);
  await harness.emit("input", inputEvent("next"), context.ctx);
  assert.match(context.dialogLines.join("\n"), /Session idle for 6m34s/);
});

test("requires known percentage or token usage at or above threshold", async () => {
  const cases: Array<{
    threshold: ContextThreshold;
    usage: ContextUsage | undefined;
    expectedCalls: number;
  }> = [
    { threshold: { unit: "percent", value: 5 }, usage: { ...DEFAULT_USAGE, percent: 4.999 }, expectedCalls: 0 },
    { threshold: { unit: "percent", value: 5 }, usage: { ...DEFAULT_USAGE, percent: 5 }, expectedCalls: 1 },
    { threshold: { unit: "tokens", value: 50_000 }, usage: { ...DEFAULT_USAGE, tokens: 49_999 }, expectedCalls: 0 },
    { threshold: { unit: "tokens", value: 50_000 }, usage: { ...DEFAULT_USAGE, tokens: 50_000 }, expectedCalls: 1 },
    { threshold: { unit: "percent", value: 5 }, usage: undefined, expectedCalls: 0 },
    { threshold: { unit: "percent", value: 5 }, usage: { ...DEFAULT_USAGE, percent: null }, expectedCalls: 0 },
  ];

  for (const testCase of cases) {
    const harness = createHarness(180_001, testCase.threshold);
    const context = createContext([assistantEntry(0)], [CANCEL], { usage: testCase.usage });
    await start(harness, context);
    await harness.emit("input", inputEvent("next"), context.ctx);
    assert.equal(context.dialogCalls, testCase.expectedCalls);
  }
});

test("raw user activity resets before idle threshold and latches after it", async () => {
  const early = createHarness(179_999);
  const earlyContext = createContext([assistantEntry(0)], [CANCEL]);
  await start(early, earlyContext);
  earlyContext.terminalHandler?.("x");
  early.setNow(180_001);
  await early.emit("input", inputEvent("next"), earlyContext.ctx);
  assert.equal(earlyContext.dialogCalls, 0);

  const late = createHarness(180_001);
  const lateContext = createContext([assistantEntry(0)], [CANCEL]);
  await start(late, lateContext);
  lateContext.terminalHandler?.("x");
  late.setNow(180_002);
  await late.emit("input", inputEvent("next"), lateContext.ctx);
  assert.equal(lateContext.dialogCalls, 1);
});

test("new, explicit streaming, RPC, extension, and non-TUI inputs bypass the dialog", async () => {
  const cases: Array<{
    entries?: SessionEntry[];
    event?: unknown;
    context?: Parameters<typeof createContext>[2];
  }> = [
    { entries: [] },
    { event: inputEvent("next", { streamingBehavior: "steer" }), context: { idle: false } },
    { event: inputEvent("next", { streamingBehavior: "followUp" }), context: { idle: false } },
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
    assert.equal(context.dialogCalls, 0);
    assert.deepEqual(harness.sends, []);
  }
});

test("active input without a delivery mode is re-sent as steering", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL], { idle: false });
  const image = { type: "image" as const, data: "base64", mimeType: "image/png" };
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("redirect", { images: [image] }), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(context.dialogCalls, 0);
  assert.deepEqual(harness.sends, [
    {
      content: [{ type: "text", text: "redirect" }, image],
      options: { deliverAs: "steer", expandPromptTemplates: true },
    },
  ]);
});

test("Enter passes original input through without compaction", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [SEND_WITHOUT_COMPACTING]);
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("unchanged"), context.ctx);
  assert.deepEqual(result, { action: "continue" });
  assert.equal(context.compactOptions, undefined);
  assert.deepEqual(harness.sends, []);
});

test("cancel restores input without overwriting a newer draft", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL], { editorText: "new draft" });
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("original"), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(context.editorText, "original\nnew draft");
  assert.deepEqual(harness.sends, []);
});

test("compact withholds, replays exact content once, and preserves a newer draft", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [COMPACT_AND_SEND], { editorText: "new draft" });
  const image = { type: "image" as const, data: "base64", mimeType: "image/png" };
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("/template arg", { images: [image] }), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.deepEqual(harness.sends, []);
  assert.ok(context.compactOptions?.onComplete);

  context.compactOptions.onComplete?.({} as never);
  assert.equal(context.editorText, "/template arg\nnew draft");
  assert.deepEqual(harness.sends, [
    {
      content: [{ type: "text", text: "/template arg" }, image],
      options: { expandPromptTemplates: true },
    },
  ]);

  await harness.emit("agent_start", { type: "agent_start" }, context.ctx);
  assert.equal(context.editorText, "new draft");

  harness.setNow(900_000);
  const recursive = await harness.emit(
    "input",
    inputEvent("/template arg", { source: "extension", images: [image] }),
    context.ctx,
  );
  assert.deepEqual(recursive, { action: "continue" });
  assert.equal(context.dialogCalls, 1);
});

test("compact replay dispatch failure restores prompt and reports error", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [COMPACT_AND_SEND]);
  await start(harness, context);
  await harness.emit("input", inputEvent("original"), context.ctx);
  harness.failNextSend(new Error("dispatch unavailable"));

  context.compactOptions?.onComplete?.({} as never);
  assert.deepEqual(harness.sends, []);
  assert.equal(context.editorText, "original");
  assert.deepEqual(context.notifications, [
    { message: "Compaction replay failed; prompt was not sent: dispatch unavailable", type: "error" },
  ]);

  await harness.emit("agent_start", { type: "agent_start" }, context.ctx);
  assert.equal(context.editorText, "original");
});

test("compaction failure sends nothing, reports error, restores text, and retains decision", async () => {
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
  assert.equal(context.dialogCalls, 2);
});

test("dialog errors fail closed and restore prompt", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [new Error("UI unavailable")]);
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("original"), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  assert.equal(context.editorText, "original");
  assert.deepEqual(harness.sends, []);
  assert.match(context.notifications[0]?.message ?? "", /prompt was not sent: UI unavailable/);
});

test("C bridge dispatch failure restores prompt and reports error", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [NEW_SESSION_AND_SEND]);
  harness.failNextSend(new Error("dispatch unavailable"));
  await start(harness, context);

  await harness.emit("input", inputEvent("original"), context.ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.sends, []);
  assert.equal(context.editorText, "original");
  assert.deepEqual(context.notifications, [
    { message: "New-session dispatch failed; prompt was not sent: dispatch unavailable", type: "error" },
  ]);
});

test("C dispatches public command bridge and replays exact content in replacement session", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [NEW_SESSION_AND_SEND]);
  const image = { type: "image" as const, data: "base64", mimeType: "image/png" };
  await start(harness, context);

  const result = await harness.emit("input", inputEvent("/template arg", { images: [image] }), context.ctx);
  assert.deepEqual(result, { action: "handled" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.sends, [
    { content: `/${NEW_SESSION_COMMAND}`, options: { expandPromptTemplates: true } },
  ]);

  const replacementSends: Array<{ content: SendContent; options: SendOptions }> = [];
  const replacement = {
    ui: context.ctx.ui,
    async sendUserMessage(content: SendContent, options: SendOptions) {
      replacementSends.push({ content, options });
    },
  } as unknown as ReplacementContext;
  const commandContext = {
    ui: context.ctx.ui,
    async newSession(options: Parameters<ExtensionCommandContext["newSession"]>[0]) {
      await options?.withSession?.(replacement);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  await harness.commands.get(NEW_SESSION_COMMAND)?.("", commandContext);
  assert.deepEqual(replacementSends, [
    {
      content: [{ type: "text", text: "/template arg" }, image],
      options: { expandPromptTemplates: true },
    },
  ]);
});

test("new-session cancellation restores prompt without sending", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [NEW_SESSION_AND_SEND]);
  await start(harness, context);
  await harness.emit("input", inputEvent("original"), context.ctx);
  const commandContext = {
    ui: context.ctx.ui,
    async newSession() {
      return { cancelled: true };
    },
  } as unknown as ExtensionCommandContext;

  await harness.commands.get(NEW_SESSION_COMMAND)?.("", commandContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.sends, []);
  assert.equal(context.editorText, "original");
  assert.deepEqual(context.notifications, [
    { message: "New session was cancelled; prompt was not sent", type: "warning" },
  ]);
});

test("new-session creation failure restores prompt and reports error", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [NEW_SESSION_AND_SEND]);
  await start(harness, context);
  await harness.emit("input", inputEvent("original"), context.ctx);
  const commandContext = {
    ui: context.ctx.ui,
    async newSession() {
      throw new Error("replacement unavailable");
    },
  } as unknown as ExtensionCommandContext;

  await harness.commands.get(NEW_SESSION_COMMAND)?.("", commandContext);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.sends, []);
  assert.equal(context.editorText, "original");
  assert.deepEqual(context.notifications, [
    { message: "New session failed; prompt was not sent: replacement unavailable", type: "error" },
  ]);
});

test("new-session replay failure restores prompt in replacement editor", async () => {
  const harness = createHarness(180_001);
  const oldContext = createContext([assistantEntry(0)], [NEW_SESSION_AND_SEND]);
  const replacementContext = createContext([]);
  await start(harness, oldContext);
  await harness.emit("input", inputEvent("original"), oldContext.ctx);

  const replacement = {
    ui: replacementContext.ctx.ui,
    async sendUserMessage() {
      throw new Error("no model");
    },
  } as unknown as ReplacementContext;
  const commandContext = {
    ui: oldContext.ctx.ui,
    async newSession(options: Parameters<ExtensionCommandContext["newSession"]>[0]) {
      await options?.withSession?.(replacement);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  await harness.commands.get(NEW_SESSION_COMMAND)?.("", commandContext);
  assert.equal(replacementContext.editorText, "original");
  assert.deepEqual(replacementContext.notifications, [
    { message: "New-session replay failed; prompt was not sent: no model", type: "error" },
  ]);
});

test("agent and compaction settlement restart idle interval", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL]);
  await start(harness, context);

  await harness.emit("agent_start", { type: "agent_start" }, context.ctx);
  harness.setNow(900_000);
  await harness.emit("input", inputEvent("during run"), context.ctx);
  assert.equal(context.dialogCalls, 0);

  await harness.emit("agent_settled", { type: "agent_settled" }, context.ctx);
  harness.setNow(1_080_000);
  await harness.emit("input", inputEvent("boundary"), context.ctx);
  assert.equal(context.dialogCalls, 0);

  await harness.emit("session_compact", { type: "session_compact" }, context.ctx);
  harness.setNow(1_260_001);
  await harness.emit("input", inputEvent("after compact"), context.ctx);
  assert.equal(context.dialogCalls, 1);
});

test("shutdown removes terminal listener and clears session state", async () => {
  const harness = createHarness(180_001);
  const context = createContext([assistantEntry(0)], [CANCEL]);
  await start(harness, context);
  assert.ok(context.terminalHandler);

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, context.ctx);
  assert.equal(context.terminalHandler, undefined);
  await harness.emit("input", inputEvent("next"), context.ctx);
  assert.equal(context.dialogCalls, 0);
});
