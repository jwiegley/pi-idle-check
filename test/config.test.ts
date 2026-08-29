import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONFIG_FILE_NAME,
  DEFAULT_CONTEXT_THRESHOLD,
  loadContextThreshold,
  meetsContextThreshold,
  parseContextThreshold,
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

test("rejects malformed threshold configuration", () => {
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

test("loads default, global, and trusted project thresholds in precedence order", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-idle-config-test-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectDir = join(cwd, ".pi");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });

  try {
    assert.deepEqual(loadContextThreshold(cwd, true, agentDir), DEFAULT_CONTEXT_THRESHOLD);

    writeFileSync(join(agentDir, CONFIG_FILE_NAME), '{"contextThreshold":50000}');
    assert.deepEqual(loadContextThreshold(cwd, true, agentDir), {
      unit: "tokens",
      value: 50_000,
    });

    writeFileSync(join(projectDir, CONFIG_FILE_NAME), '{"contextThreshold":"7.5%"}');
    assert.deepEqual(loadContextThreshold(cwd, true, agentDir), {
      unit: "percent",
      value: 7.5,
    });

    writeFileSync(join(agentDir, CONFIG_FILE_NAME), "not json");
    assert.deepEqual(loadContextThreshold(cwd, true, agentDir), {
      unit: "percent",
      value: 7.5,
    });
    writeFileSync(join(agentDir, CONFIG_FILE_NAME), '{"contextThreshold":50000}');

    writeFileSync(join(projectDir, CONFIG_FILE_NAME), "not json");
    assert.deepEqual(loadContextThreshold(cwd, false, agentDir), {
      unit: "tokens",
      value: 50_000,
    });
    assert.throws(() => loadContextThreshold(cwd, true, agentDir), /invalid .*pi-idle-check\.json/);
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
