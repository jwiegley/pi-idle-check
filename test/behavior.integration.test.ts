import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type CreateAgentSessionOptions,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { CANCEL, COMPACT_AND_SEND, createPiIdleCheck } from "../index.ts";
import { createTestHost, type TestHost } from "./support/host.ts";

type TestTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];

type UiHarness = {
  ui: ExtensionUIContext;
  readonly selectCalls: number;
};

function selectionUi(choice: string | undefined): UiHarness {
  let editorText = "";
  let selectCalls = 0;
  return {
    ui: {
      async select() {
        selectCalls++;
        return choice;
      },
      notify() {},
      onTerminalInput() {
        return () => {};
      },
      getEditorText() {
        return editorText;
      },
      setEditorText(text: string) {
        editorText = text;
      },
    } as unknown as ExtensionUIContext,
    get selectCalls() {
      return selectCalls;
    },
  };
}

function seedCompactableSession(host: TestHost): number {
  const model = host.faux.getModel();
  host.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "message to compact" }],
    timestamp: Date.now() - 1_000,
  });
  host.sessionManager.appendMessage({
    ...fauxAssistantMessage("assistant response to compact"),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  host.session.agent.state.messages = host.sessionManager.buildSessionContext().messages;
  return Date.parse(host.sessionManager.getLeafEntry()?.timestamp ?? "");
}

function latestUserText(context: Context): string {
  const message = [...context.messages].reverse().find((candidate) => candidate.role === "user");
  assert.ok(message?.role === "user");
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function nextSettlement(host: TestHost): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = host.session.subscribe((event) => {
      if (event.type !== "agent_settled") return;
      unsubscribe();
      resolve();
    });
  });
}

async function replayExpandedInput(options: {
  input: string;
  prompts?: Record<string, string>;
  skills?: Record<string, string>;
}): Promise<string> {
  let now = 0;
  let expanded = "";
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now }) }],
    {
      extensionPaths: [],
      ...(options.prompts === undefined ? {} : { prompts: options.prompts }),
      settings: {
        compaction: { keepRecentTokens: 1, reserveTokens: 0 },
        enableSkillCommands: true,
      },
      ...(options.skills === undefined ? {} : { skills: options.skills }),
    },
  );
  now = seedCompactableSession(host) + 180_001;
  host.faux.setResponses([
    fauxAssistantMessage("summary"),
    (context) => {
      expanded = latestUserText(context);
      return fauxAssistantMessage("expanded response");
    },
  ]);
  const ui = selectionUi(COMPACT_AND_SEND);

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    const settled = nextSettlement(host);
    await host.session.prompt(options.input);
    await settled;
    assert.equal(ui.selectCalls, 1);
    assert.equal(host.faux.state.callCount, 2);
    return expanded;
  } finally {
    host.cleanup();
  }
}

test("compact replay performs real prompt-template expansion", async () => {
  const expanded = await replayExpandedInput({
    input: "/expand value",
    prompts: {
      "expand.md": "---\ndescription: Expansion fixture\n---\nTEMPLATE_EXPANDED:$1\n",
    },
  });
  assert.equal(expanded.trim(), "TEMPLATE_EXPANDED:value");
});

test("compact replay performs real skill-command expansion", async () => {
  const expanded = await replayExpandedInput({
    input: "/skill:audit details",
    skills: {
      audit: "---\nname: audit\ndescription: Audit fixture\n---\nSKILL_EXPANDED_MARKER\n",
    },
  });
  assert.match(expanded, /SKILL_EXPANDED_MARKER/);
  assert.match(expanded, /<\/skill>\n\ndetails$/);
});

test("tool activity starts idle time only after the full tool loop settles", async () => {
  let now = 0;
  let toolRuns = 0;
  const tool = {
    name: "clock",
    label: "Clock",
    description: "Advance the test clock",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      toolRuns++;
      now = 500_000;
      return { content: [{ type: "text", text: "advanced" }], details: {} };
    },
  } as unknown as TestTool;
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now }) }],
    { customTools: [tool], extensionPaths: [] },
  );
  const ui = selectionUi(CANCEL);
  host.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("clock", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("tool loop done"),
    fauxAssistantMessage("boundary response"),
  ]);

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("run the tool");
    assert.equal(toolRuns, 1);

    now = 680_000;
    await host.session.prompt("at the strict boundary");
    assert.equal(ui.selectCalls, 0);
    assert.equal(host.faux.state.callCount, 3);
  } finally {
    host.cleanup();
  }
});

test("automatic retry starts idle time only after the recovered run settles", async () => {
  let now = 0;
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now }) }],
    {
      extensionPaths: [],
      settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
    },
  );
  const ui = selectionUi(CANCEL);
  host.faux.setResponses([
    () => {
      now = 500_000;
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
    },
    () => {
      now = 700_000;
      return fauxAssistantMessage("recovered");
    },
    fauxAssistantMessage("boundary response"),
  ]);

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.prompt("retry me");
    now = 880_000;
    await host.session.prompt("at the strict boundary");
    assert.equal(ui.selectCalls, 0);
    assert.equal(host.faux.state.callCount, 3);
  } finally {
    host.cleanup();
  }
});

test("real extension reload reseeds the idle decision from persisted entries", async () => {
  let now = 0;
  const reasons: string[] = [];
  const host = await createTestHost(
    [
      { name: "idle-check", factory: createPiIdleCheck({ now: () => now }) },
      {
        name: "observer",
        factory(pi) {
          pi.on("session_start", (event) => {
            reasons.push(event.reason);
          });
        },
      },
    ],
    { extensionPaths: [] },
  );
  now = seedCompactableSession(host) + 180_001;
  const ui = selectionUi(CANCEL);

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await host.session.reload();
    await host.session.prompt("after reload");
    assert.deepEqual(reasons, ["startup", "reload"]);
    assert.equal(ui.selectCalls, 1);
    assert.equal(host.faux.state.callCount, 0);
  } finally {
    host.cleanup();
  }
});

test("real runtime resume reseeds the idle decision from the restored session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-idle-resume-test-"));
  const agentDir = join(root, "agent");
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory();
  const reasons: string[] = [];
  let now = 0;
  const idleFactory = createPiIdleCheck({ now: () => now });
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [
          { name: "idle-check", factory: idleFactory },
          {
            name: "observer",
            factory(pi) {
              pi.on("session_start", (event) => {
                reasons.push(event.reason);
              });
            },
          },
        ],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        model: faux.getModel(),
        tools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: root,
    agentDir,
    sessionManager: SessionManager.create(root),
  });
  const ui = selectionUi(CANCEL);

  try {
    await runtime.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    faux.setResponses([fauxAssistantMessage("persisted response")]);
    await runtime.session.prompt("persist this session");
    const originalSessionFile = runtime.session.sessionFile;
    assert.ok(originalSessionFile);
    now = Date.parse(runtime.session.sessionManager.getLeafEntry()?.timestamp ?? "") + 180_001;

    await runtime.newSession();
    await runtime.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    const switched = await runtime.switchSession(originalSessionFile);
    assert.equal(switched.cancelled, false);
    await runtime.session.bindExtensions({ mode: "tui", uiContext: ui.ui });
    await runtime.session.prompt("after resume");

    assert.ok(reasons.includes("resume"));
    assert.equal(ui.selectCalls, 1);
    assert.equal(faux.state.callCount, 1);
  } finally {
    await runtime.dispose();
    modelRuntime.unregisterProvider(faux.provider.id);
    rmSync(root, { recursive: true, force: true });
  }
});
