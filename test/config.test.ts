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
  resolveIdleThresholdMs,
} from "../src/config.ts";

test("parses percentage and absolute token thresholds", () => {
  assert.deepEqual(parseContextThreshold({ contextThreshold: "5%" }), {
    unit: "percent",
    value: 5,
  });
  assert.deepEqual(parseContextThreshold({ contextThreshold: ".25%" }), {
    unit: "percent",
    value: 0.25,
  });
  assert.deepEqual(parseContextThreshold({ contextThreshold: 50_000 }), {
    unit: "tokens",
    value: 50_000,
  });
});

test("rejects malformed context threshold configuration", () => {
  for (const config of [
    null,
    {},
    { contextThreshold: "5%", extra: true },
    { contextThreshold: "0%" },
    { contextThreshold: "100.1%" },
    { contextThreshold: " 5%" },
    { contextThreshold: 0 },
    { contextThreshold: 1.5 },
    { contextThreshold: "50000" },
  ]) {
    assert.throws(() => parseContextThreshold(config), { name: "Error" });
  }
});

test("parses global and provider idle-delay configuration", () => {
  assert.deepEqual(
    parseIdleCheckConfig({
      contextThreshold: "7.5%",
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    }),
    {
      contextThreshold: { unit: "percent", value: 7.5 },
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    },
  );
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
      contextThreshold: DEFAULT_CONTEXT_THRESHOLD,
      idleThresholdMinutes: DEFAULT_IDLE_THRESHOLD_MINUTES,
      providerIdleThresholdMinutes: {},
    });

    writeFileSync(
      join(agentDir, CONFIG_FILE_NAME),
      '{"contextThreshold":50000,"idleThresholdMinutes":3,"providerIdleThresholdMinutes":{"openai-codex":10}}',
    );
    assert.deepEqual(loadIdleCheckConfig(cwd, true, agentDir), {
      contextThreshold: { unit: "tokens", value: 50_000 },
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    });

    writeFileSync(
      join(projectDir, CONFIG_FILE_NAME),
      '{"idleThresholdMinutes":4,"providerIdleThresholdMinutes":{"openai-codex":12,"anthropic":7}}',
    );
    const merged = loadIdleCheckConfig(cwd, true, agentDir);
    assert.deepEqual(merged, {
      contextThreshold: { unit: "tokens", value: 50_000 },
      idleThresholdMinutes: 4,
      providerIdleThresholdMinutes: { "openai-codex": 12, anthropic: 7 },
    });
    assert.equal(resolveIdleThresholdMs(merged, "openai-codex"), 720_000);
    assert.equal(resolveIdleThresholdMs(merged, "unmatched-provider"), 240_000);
    assert.equal(loadContextThreshold(cwd, true, agentDir).value, 50_000);

    assert.deepEqual(loadIdleCheckConfig(cwd, false, agentDir), {
      contextThreshold: { unit: "tokens", value: 50_000 },
      idleThresholdMinutes: 3,
      providerIdleThresholdMinutes: { "openai-codex": 10 },
    });

    writeFileSync(join(projectDir, CONFIG_FILE_NAME), '{"idleThresholdMinutes":0}');
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
