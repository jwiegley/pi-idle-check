import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_FILE_NAME,
  DEFAULT_CONTEXT_THRESHOLD,
  DEFAULT_IDLE_THRESHOLD_MINUTES,
  loadContextThreshold,
  loadIdleCheckConfig,
  meetsContextThreshold,
  parseContextThreshold,
  parseIdleCheckConfig,
  resolveIdleCheckSettings,
  resolveIdleThresholdMs,
  type IdleCheckConfig,
} from "../src/config.ts";

test("parses integer percentage thresholds", () => {
  assert.deepEqual(parseContextThreshold({ contextThreshold: 10 }), {
    unit: "percent",
    value: 10,
  });
  assert.deepEqual(parseContextThreshold({ contextThreshold: 100 }), {
    unit: "percent",
    value: 100,
  });
});

test("rejects malformed context threshold configuration", () => {
  for (const config of [
    null,
    {},
    { contextThreshold: 5, extra: true },
    { contextThreshold: 0 },
    { contextThreshold: 101 },
    { contextThreshold: 1.5 },
    { contextThreshold: "10%" },
    { contextThreshold: "10" },
  ]) {
    assert.throws(() => parseContextThreshold(config), { name: "Error" });
  }
});

test("parses global and provider idle-delay configuration", () => {
  assert.deepEqual(
    parseIdleCheckConfig({
      contextThreshold: 10,
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    }),
    {
      contextThreshold: { unit: "percent", value: 10 },
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    },
  );
});

test("parses provider and provider-qualified model settings", () => {
  assert.deepEqual(
    parseIdleCheckConfig({
      enabled: false,
      providers: {
        "omlx-hera": { enabled: false },
        cloud: { idleThresholdMinutes: 10, contextThreshold: 20 },
      },
      models: { "cloud/org/model": { enabled: true, idleThresholdMinutes: 2, contextThreshold: 1 } },
    }),
    {
      enabled: false,
      providers: {
        "omlx-hera": { enabled: false },
        cloud: { idleThresholdMinutes: 10, contextThreshold: { unit: "percent", value: 20 } },
      },
      models: {
        "cloud/org/model": {
          enabled: true, idleThresholdMinutes: 2, contextThreshold: { unit: "percent", value: 1 },
        },
      },
    },
  );
});

test("rejects malformed scoped settings rather than silently ignoring them", () => {
  for (const scope of ["providers", "models"]) {
    const key = scope === "providers" ? "cloud" : "cloud/model";
    for (const value of [null, [], false, 10, { "": {} }]) {
      assert.throws(() => parseIdleCheckConfig({ [scope]: value }));
    }
    for (const settings of [
      null, [], false, { enabled: "false" }, { enabled: 0 }, { contextThreshold: 0 },
      { contextThreshold: 101 }, { contextThreshold: 1.5 }, { contextThreshold: "10%" },
      { idleThresholdMinutes: 0 }, { idleThresholdMinutes: -1 }, { idleThresholdMinutes: 1.5 },
      { idleThresholdMinutes: Infinity }, { idleThresholdMinutes: Number.MAX_SAFE_INTEGER },
      { unknown: 1 }, { models: {} },
    ]) {
      assert.throws(() => parseIdleCheckConfig({ [scope]: { [key]: settings } }));
    }
  }
  for (const key of ["model", "/model", "provider/", " "]) {
    assert.throws(() => parseIdleCheckConfig({ models: { [key]: {} } }), /keys must/);
  }
  assert.throws(() => parseIdleCheckConfig({ enabled: "false" }), /enabled must be a boolean/);
});

test("resolves each setting from defaults, legacy delay, provider, then model", () => {
  const config: IdleCheckConfig = {
    enabled: true,
    idleThresholdMinutes: 5,
    contextThreshold: DEFAULT_CONTEXT_THRESHOLD,
    providerIdleThresholdMinutes: { cloud: 8, legacy: 9 },
    providers: {
      cloud: { idleThresholdMinutes: 10, contextThreshold: { unit: "percent", value: 20 } },
      "omlx-hera": { enabled: false },
    },
    models: {
      "cloud/fast": { idleThresholdMinutes: 2 },
      "cloud/org/model": { contextThreshold: { unit: "percent", value: 30 } },
      "cloud/off": { enabled: false },
      "omlx-hera/exception": { enabled: true, idleThresholdMinutes: 1 },
    },
  };
  const defaults = { enabled: true, idleThresholdMinutes: 5, contextThreshold: DEFAULT_CONTEXT_THRESHOLD };
  for (const provider of [undefined, "unknown", "constructor", "__proto__"]) {
    assert.deepEqual(resolveIdleCheckSettings(config, provider, "fast"), defaults);
  }
  assert.equal(resolveIdleThresholdMs(config, "legacy"), 540_000);
  assert.equal(resolveIdleThresholdMs(config, "cloud", "missing"), 600_000);
  assert.deepEqual(resolveIdleCheckSettings(config, "cloud", "fast"), {
    enabled: true, idleThresholdMinutes: 2, contextThreshold: { unit: "percent", value: 20 },
  });
  assert.deepEqual(resolveIdleCheckSettings(config, "cloud", "org/model"), {
    enabled: true, idleThresholdMinutes: 10, contextThreshold: { unit: "percent", value: 30 },
  });
  assert.equal(resolveIdleThresholdMs(config, "omlx-hera", "anything"), Infinity);
  assert.equal(resolveIdleThresholdMs(config, "cloud", "off"), Infinity);
  assert.equal(resolveIdleThresholdMs(config, "omlx-hera", "exception"), 60_000);
  assert.equal(resolveIdleThresholdMs({ ...config, enabled: false }, "cloud", "fast"), Infinity);
  assert.equal(resolveIdleThresholdMs({ ...config, enabled: false }, "omlx-hera", "exception"), 60_000);
});

test("rejects malformed idle-delay configuration", () => {
  for (const config of [
    null,
    {},
    { unknown: true },
    { idleThresholdMinutes: 0 },
    { idleThresholdMinutes: 1.5 },
    { providerIdleThresholdMinutes: null },
    { providerIdleThresholdMinutes: { "": 10 } },
    { providerIdleThresholdMinutes: { "openai-codex": "10" } },
  ]) {
    assert.throws(() => parseIdleCheckConfig(config), { name: "Error" });
  }
});

test("loads merged global and trusted project configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-idle-config-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  try {
    assert.deepEqual(loadIdleCheckConfig(cwd, true, agentDir), {
      enabled: true,
      providers: {},
      models: {},
      contextThreshold: DEFAULT_CONTEXT_THRESHOLD,
      idleThresholdMinutes: DEFAULT_IDLE_THRESHOLD_MINUTES,
      providerIdleThresholdMinutes: {},
    });

    writeFileSync(
      join(agentDir, CONFIG_FILE_NAME),
      '{"contextThreshold":10,"idleThresholdMinutes":3,"providerIdleThresholdMinutes":{"openai-codex":10}}',
    );
    assert.deepEqual(loadIdleCheckConfig(cwd, true, agentDir), {
      enabled: true,
      providers: {},
      models: {},
      contextThreshold: { unit: "percent", value: 10 },
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    });

    writeFileSync(
      join(projectDir, CONFIG_FILE_NAME),
      '{"idleThresholdMinutes":4,"providerIdleThresholdMinutes":{"openai-codex":12,"anthropic":7}}',
    );
    const merged = loadIdleCheckConfig(cwd, true, agentDir);
    assert.deepEqual(merged, {
      enabled: true,
      providers: {},
      models: {},
      contextThreshold: { unit: "percent", value: 10 },
      idleThresholdMinutes: 4,
      providerIdleThresholdMinutes: { "openai-codex": 12, anthropic: 7 },
    });
    assert.equal(resolveIdleThresholdMs(merged, "openai-codex"), 720_000);
    assert.equal(resolveIdleThresholdMs(merged, "unmatched-provider"), 240_000);
    assert.equal(loadContextThreshold(cwd, true, agentDir).value, 10);

    assert.deepEqual(loadIdleCheckConfig(cwd, false, agentDir), {
      enabled: true,
      providers: {},
      models: {},
      contextThreshold: { unit: "percent", value: 10 },
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    });

    writeFileSync(join(projectDir, CONFIG_FILE_NAME), '{"idleThresholdMinutes":0}');
    assert.throws(() => loadIdleCheckConfig(cwd, true, agentDir), /invalid .*pi-idle-check\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted project maps replace matching entries and retain other global entries", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-idle-overrides-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  try {
    writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({
      enabled: false,
      providers: {
        cloud: { enabled: false, idleThresholdMinutes: 10 },
        "omlx-hera": { enabled: false },
      },
      models: { "cloud/model": { enabled: false }, "cloud/retained": { idleThresholdMinutes: 8 } },
    }));
    const global = loadIdleCheckConfig(cwd, false, agentDir);
    writeFileSync(join(cwd, ".pi", CONFIG_FILE_NAME), JSON.stringify({
      enabled: true,
      providers: { cloud: { contextThreshold: 20 } },
      models: { "cloud/model": {} },
    }));
    assert.deepEqual(loadIdleCheckConfig(cwd, false, agentDir), global);
    const merged = loadIdleCheckConfig(cwd, true, agentDir);
    assert.deepEqual(merged.providers, {
      cloud: { contextThreshold: { unit: "percent", value: 20 } },
      "omlx-hera": { enabled: false },
    });
    assert.deepEqual(merged.models, { "cloud/model": {}, "cloud/retained": { idleThresholdMinutes: 8 } });
    assert.deepEqual(resolveIdleCheckSettings(merged, "cloud", "model"), {
      enabled: true, idleThresholdMinutes: 5, contextThreshold: { unit: "percent", value: 20 },
    });
    assert.equal(resolveIdleThresholdMs(merged, "cloud", "retained"), 480_000);
    writeFileSync(join(cwd, ".pi", CONFIG_FILE_NAME), '{"providers":{"cloud":{"enabled":"false"}}}');
    assert.deepEqual(loadIdleCheckConfig(cwd, false, agentDir), global);
    assert.throws(() => loadIdleCheckConfig(cwd, true, agentDir), /invalid .*pi-idle-check\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matches known context usage at or above the configured boundary", () => {
  const usage = (tokens: number | null, percent: number | null) => ({
    tokens,
    percent,
    contextWindow: 1_000_000,
  });

  assert.equal(meetsContextThreshold({ unit: "percent", value: 5 }, usage(49_999, 4.9999)), false);
  assert.equal(meetsContextThreshold({ unit: "percent", value: 5 }, usage(50_000, 5)), true);
  assert.equal(meetsContextThreshold({ unit: "tokens", value: 50_000 }, usage(49_999, 4.9999)), false);
  assert.equal(meetsContextThreshold({ unit: "tokens", value: 50_000 }, usage(50_000, 5)), true);
  assert.equal(meetsContextThreshold({ unit: "percent", value: 5 }, undefined), false);
  assert.equal(meetsContextThreshold({ unit: "percent", value: 5 }, usage(50_000, null)), false);
  assert.equal(meetsContextThreshold({ unit: "tokens", value: 50_000 }, usage(null, 5)), false);
});
