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

export type IdleCheckSettings = {
  enabled: boolean;
  contextThreshold: ContextThreshold;
  idleThresholdMinutes: number;
};

export type IdleCheckConfig = IdleCheckSettings & {
  providerIdleThresholdMinutes: Record<string, number>;
  providers: Record<string, Partial<IdleCheckSettings>>;
  models: Record<string, Partial<IdleCheckSettings>>;
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
    throw new Error('expected exactly {"contextThreshold":5}');
  }

  const value = config.contextThreshold;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 100
  ) {
    return { unit: "percent", value };
  }

  throw new Error("contextThreshold must be an integer percentage from 1 through 100");
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

function parseIdleCheckSettings(config: unknown, name: string): Partial<IdleCheckSettings> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`${name} must be an object`);
  }
  const parsed: Partial<IdleCheckSettings> = {};
  for (const [key, value] of Object.entries(config)) {
    switch (key) {
      case "enabled":
        if (typeof value !== "boolean") throw new Error(`${name}.enabled must be a boolean`);
        parsed.enabled = value;
        break;
      case "contextThreshold":
        parsed.contextThreshold = parseContextThreshold({ contextThreshold: value });
        break;
      case "idleThresholdMinutes":
        parsed.idleThresholdMinutes = parseIdleThresholdMinutes(value, `${name}.${key}`);
        break;
      default:
        throw new Error(`unknown setting ${name}.${key}`);
    }
  }
  return parsed;
}

function parseOverrides(
  value: unknown,
  name: "providers" | "models",
): Record<string, Partial<IdleCheckSettings>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object keyed by ${name === "providers" ? "provider ID" : "provider/model ID"}`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, settings]) => {
      if (key.trim().length === 0) throw new Error(`${name} keys must be non-empty IDs`);
      if (name === "models" && (key.indexOf("/") <= 0 || key.indexOf("/") === key.length - 1)) {
        throw new Error("models keys must be provider/model IDs");
      }
      return [key, parseIdleCheckSettings(settings, `${name}.${key}`)];
    }),
  );
}

export function parseIdleCheckConfig(config: unknown): IdleCheckConfigFile {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error("expected a JSON object");
  }
  if (Object.keys(config).length === 0) throw new Error("expected at least one configuration setting");
  const { providers, models, providerIdleThresholdMinutes, ...settings } = config as Record<string, unknown>;
  const parsed: IdleCheckConfigFile = parseIdleCheckSettings(settings, "configuration");
  if ("providers" in config) parsed.providers = parseOverrides(providers, "providers");
  if ("models" in config) parsed.models = parseOverrides(models, "models");
  if ("providerIdleThresholdMinutes" in config) {
    const providerOverrides = providerIdleThresholdMinutes;
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
    enabled: project?.enabled ?? global?.enabled ?? true,
    contextThreshold: project?.contextThreshold ?? global?.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD,
    idleThresholdMinutes:
      project?.idleThresholdMinutes ?? global?.idleThresholdMinutes ?? DEFAULT_IDLE_THRESHOLD_MINUTES,
    providerIdleThresholdMinutes: {
      ...global?.providerIdleThresholdMinutes,
      ...project?.providerIdleThresholdMinutes,
    },
    providers: { ...global?.providers, ...project?.providers },
    models: { ...global?.models, ...project?.models },
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

function getOverride<T>(overrides: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(overrides, key) ? overrides[key] : undefined;
}

export function resolveIdleCheckSettings(
  config: IdleCheckConfig,
  provider: string | undefined,
  modelId?: string,
): IdleCheckSettings {
  const modelKey = provider !== undefined && modelId !== undefined ? `${provider}/${modelId}` : undefined;
  return {
    enabled: config.enabled,
    contextThreshold: config.contextThreshold,
    idleThresholdMinutes:
      getOverride(config.providerIdleThresholdMinutes, provider) ?? config.idleThresholdMinutes,
    ...getOverride(config.providers, provider),
    ...getOverride(config.models, modelKey),
  };
}

export function resolveIdleThresholdMs(
  config: IdleCheckConfig,
  provider: string | undefined,
  modelId?: string,
): number {
  const settings = resolveIdleCheckSettings(config, provider, modelId);
  return settings.enabled ? settings.idleThresholdMinutes * 60_000 : Infinity;
}

export function meetsContextThreshold(
  threshold: ContextThreshold,
  usage: ContextUsage | undefined,
): boolean {
  const current = threshold.unit === "percent" ? usage?.percent : usage?.tokens;
  return current !== undefined && current !== null && current >= threshold.value;
}
