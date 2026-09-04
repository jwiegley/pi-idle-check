import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ContextUsage,
} from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-idle-check.json";
export const DEFAULT_IDLE_THRESHOLD_MINUTES = 5;
const MAX_IDLE_THRESHOLD_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60_000);

export type ContextThreshold =
  | { unit: "percent"; value: number }
  | { unit: "tokens"; value: number };

export type IdleCheckConfig = {
  contextThreshold: ContextThreshold;
  idleThresholdMinutes: number;
  providerIdleThresholdMinutes: Record<string, number>;
};

type IdleCheckConfigFile = Partial<IdleCheckConfig>;

export const DEFAULT_CONTEXT_THRESHOLD: ContextThreshold = { unit: "percent", value: 5 };

export function parseContextThreshold(config: unknown): ContextThreshold {
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config) ||
    Object.keys(config).length !== 1 ||
    !("contextThreshold" in config)
  ) {
    throw new Error('expected exactly {"contextThreshold":"5%"} or {"contextThreshold":50000}');
  }

  const value = config.contextThreshold;
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return { unit: "tokens", value };
  } else if (typeof value === "string" && /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value)) {
    const percent = Number(value.slice(0, -1));
    if (percent > 0 && percent <= 100) return { unit: "percent", value: percent };
  }

  throw new Error("contextThreshold must be a positive integer token count or a percentage above 0% and at most 100%");
}

function parseIdleThresholdMinutes(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_IDLE_THRESHOLD_MINUTES
  ) {
    throw new Error(`${name} must be a positive whole number of minutes`);
  }
  return value;
}

export function parseIdleCheckConfig(config: unknown): IdleCheckConfigFile {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("expected a JSON object");
  }

  const entries = Object.entries(config);
  if (entries.length === 0) throw new Error("expected at least one configuration setting");
  for (const [key] of entries) {
    if (
      key !== "contextThreshold" &&
      key !== "idleThresholdMinutes" &&
      key !== "providerIdleThresholdMinutes"
    ) {
      throw new Error(`unknown setting ${key}`);
    }
  }

  const parsed: IdleCheckConfigFile = {};
  if ("contextThreshold" in config) {
    parsed.contextThreshold = parseContextThreshold({ contextThreshold: config.contextThreshold });
  }
  if ("idleThresholdMinutes" in config) {
    parsed.idleThresholdMinutes = parseIdleThresholdMinutes(
      config.idleThresholdMinutes,
      "idleThresholdMinutes",
    );
  }
  if ("providerIdleThresholdMinutes" in config) {
    const providerOverrides = config.providerIdleThresholdMinutes;
    if (
      typeof providerOverrides !== "object" ||
      providerOverrides === null ||
      Array.isArray(providerOverrides)
    ) {
      throw new Error("providerIdleThresholdMinutes must be an object keyed by provider ID");
    }

    parsed.providerIdleThresholdMinutes = Object.fromEntries(
      Object.entries(providerOverrides).map(([provider, value]) => {
        if (provider.length === 0) {
          throw new Error("providerIdleThresholdMinutes keys must be non-empty provider IDs");
        }
        return [
          provider,
          parseIdleThresholdMinutes(value, `providerIdleThresholdMinutes.${provider}`),
        ];
      }),
    );
  }

  return parsed;
}

function readConfig(path: string): IdleCheckConfigFile | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return parseIdleCheckConfig(JSON.parse(source));
  } catch (error) {
    throw new Error(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadIdleCheckConfig(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
  configDirName = CONFIG_DIR_NAME,
 ): IdleCheckConfig {
  const global = readConfig(join(agentDir, CONFIG_FILE_NAME));
  const project = projectTrusted
    ? readConfig(join(cwd, configDirName, CONFIG_FILE_NAME))
    : undefined;

  return {
    contextThreshold: project?.contextThreshold ?? global?.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD,
    idleThresholdMinutes:
      project?.idleThresholdMinutes ?? global?.idleThresholdMinutes ?? DEFAULT_IDLE_THRESHOLD_MINUTES,
    providerIdleThresholdMinutes: {
      ...global?.providerIdleThresholdMinutes,
      ...project?.providerIdleThresholdMinutes,
    },
  };
}

export function loadContextThreshold(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
  configDirName = CONFIG_DIR_NAME,
 ): ContextThreshold {
  return loadIdleCheckConfig(cwd, projectTrusted, agentDir, configDirName).contextThreshold;
}

export function resolveIdleThresholdMs(config: IdleCheckConfig, provider: string | undefined): number {
  const minutes =
    (provider === undefined ? undefined : config.providerIdleThresholdMinutes[provider]) ??
    config.idleThresholdMinutes;
  return minutes * 60_000;
}

export function meetsContextThreshold(
  threshold: ContextThreshold,
  usage: ContextUsage | undefined,
): boolean {
  const current = threshold.unit === "percent" ? usage?.percent : usage?.tokens;
  return current !== undefined && current !== null && current >= threshold.value;
}
