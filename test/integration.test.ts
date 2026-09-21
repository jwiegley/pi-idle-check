import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CANCEL, COMPACT_AND_SEND, CONFIG_FILE_NAME, createPiIdleCheck, SEND_WITHOUT_COMPACTING } from "../index.ts";
import { createTestHost } from "./support/host.ts";

const TEST_THRESHOLD = { unit: "tokens", value: 1 } as const;

function testUi(
  onChoice?: () => string | undefined | Promise<string | undefined>,
): ExtensionUIContext {
  let editorText = "";
  return {
    async custom() {
      return onChoice?.();
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
  } as unknown as ExtensionUIContext;
}

test("loads the packaged extension without errors", async () => {
  const host = await createTestHost();
  try {
    assert.deepEqual(host.extensionsResult.errors, []);
    const packagePath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const extension = host.extensionsResult.extensions.find((candidate) => candidate.resolvedPath === packagePath);
    assert.ok(extension);
    assert.deepEqual([...extension.handlers.keys()].sort(), [
      "agent_settled",
      "agent_start",
      "input",
      "session_compact",
      "session_shutdown",
      "session_start",
    ]);
  } finally {
    host.cleanup();
  }
});

test("real host applies model limits, then provider disabling after reload", async () => {
  let now = 0;
  let dialogs = 0;
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now }) }],
    { extensionPaths: [] },
  );
  const model = host.faux.getModel();
  const response = fauxAssistantMessage("response with known usage");
  const tokens = Math.ceil(model.contextWindow * 0.02);
  response.usage = { ...response.usage, input: tokens, totalTokens: tokens };
  host.faux.setResponses([response, response, response]);
  const ui = testUi(() => {
    dialogs++;
    return CANCEL;
  });
  try {
    mkdirSync(join(host.root, ".pi"));
    const path = join(host.root, ".pi", CONFIG_FILE_NAME);
    const config = {
      enabled: true, idleThresholdMinutes: 1, contextThreshold: 100,
      providers: { [model.provider]: { enabled: false } },
    };
    writeFileSync(path, JSON.stringify({
      ...config,
      models: {
        [`${model.provider}/${model.id}`]: {
          enabled: true, idleThresholdMinutes: 2, contextThreshold: 1,
        },
      },
    }));
    await host.session.bindExtensions({ mode: "tui", uiContext: ui });
    await host.session.prompt("first");
    now = 120_000;
    await host.session.prompt("at model boundary");
    assert.equal(dialogs, 0);
    assert.equal(host.faux.state.callCount, 2);

    now = 240_001;
    await host.session.prompt("above model boundary");
    assert.equal(dialogs, 1);
    assert.equal(host.faux.state.callCount, 2);

    writeFileSync(path, JSON.stringify(config));
    await host.session.reload();
    now = Date.now() + 3_600_000;
    await host.session.prompt("disabled provider after reload");
    assert.equal(dialogs, 1);
    assert.equal(host.faux.state.callCount, 3);
  } finally {
    host.cleanup();
  }
});

test("does not call a provider before the idle decision", async () => {
  let now = 0;
  let hostCallCountAtDialog: number | undefined;
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now, contextThreshold: TEST_THRESHOLD }) }],
    { extensionPaths: [] },
  );
  const ui = testUi(() => {
    hostCallCountAtDialog = host.faux.state.callCount;
    return SEND_WITHOUT_COMPACTING;
  });

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui });
    await host.session.prompt("first");
    assert.equal(host.faux.state.callCount, 1);

    now = 300_001;
    await host.session.prompt("second");
    assert.equal(hostCallCountAtDialog, 1);
    assert.equal(host.faux.state.callCount, 2);
  } finally {
    host.cleanup();
  }
});

test("send choice becomes steering when agent activates while dialog is open", { timeout: 5_000 }, async () => {
  let now = 0;
  let activeStarted!: () => void;
  let releaseActive!: () => void;
  const started = new Promise<void>((resolve) => {
    activeStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now, contextThreshold: TEST_THRESHOLD }) }],
    { extensionPaths: [] },
  );
  let background: Promise<void> | undefined;
  const ui = testUi(async () => {
    background = host.session.sendUserMessage("background");
    await started;
    return SEND_WITHOUT_COMPACTING;
  });

  host.faux.setResponses([
    fauxAssistantMessage("first response"),
    async () => {
      activeStarted();
      await release;
      return fauxAssistantMessage("background response");
    },
    fauxAssistantMessage("steering response"),
  ]);

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui });
    await host.session.prompt("first");
    now = 300_001;

    try {
      await assert.doesNotReject(() => host.session.prompt("second"));
    } finally {
      releaseActive();
    }
    await background;
    assert.equal(host.faux.state.callCount, 3);
  } finally {
    releaseActive();
    await background?.catch(() => {});
    host.cleanup();
  }
});

test("real compaction completes before exact prompt replay", { timeout: 5_000 }, async () => {
  let now = 0;
  let callCountAtDialog: number | undefined;
  const host = await createTestHost(
    [{ name: "idle-check", factory: createPiIdleCheck({ now: () => now, contextThreshold: TEST_THRESHOLD }) }],
    {
      extensionPaths: [],
      settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
    },
  );
  const model = host.faux.getModel();
  const usage = {
    input: 100,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const image = { type: "image" as const, data: "base64", mimeType: "image/png" };

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
    usage,
  });
  host.session.agent.state.messages = host.sessionManager.buildSessionContext().messages;
  now = Date.parse(host.sessionManager.getBranch().at(-1)?.timestamp ?? "") + 300_001;
  host.faux.setResponses([fauxAssistantMessage("summary"), fauxAssistantMessage("replayed response")]);

  const ui = testUi(() => {
    callCountAtDialog = host.faux.state.callCount;
    return COMPACT_AND_SEND;
  });

  try {
    await host.session.bindExtensions({ mode: "tui", uiContext: ui });
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = host.session.subscribe((event) => {
        if (event.type !== "agent_settled") return;
        unsubscribe();
        resolve();
      });
    });

    await host.session.prompt("exact replay", { images: [image] });
    assert.equal(callCountAtDialog, 0);
    await settled;

    assert.equal(host.faux.state.callCount, 2);
    assert.equal(host.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    const replay = host.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .at(-1);
    assert.ok(replay?.type === "message" && replay.message.role === "user");
    assert.deepEqual(replay.message.content, [{ type: "text", text: "exact replay" }, image]);
  } finally {
    host.cleanup();
  }
});
