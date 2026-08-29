import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ContextUsage,
} from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-idle-check.json";

export type ContextThreshold =
  | { unit: "percent"; value: number }
  | { unit: "tokens"; value: number };

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

function readThreshold(path: string): ContextThreshold | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return parseContextThreshold(JSON.parse(source));
  } catch (error) {
    throw new Error(`invalid ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadContextThreshold(
  cwd: string,
  projectTrusted: boolean,
  agentDir = getAgentDir(),
  configDirName = CONFIG_DIR_NAME,
): ContextThreshold {
  if (projectTrusted) {
    const projectThreshold = readThreshold(join(cwd, configDirName, CONFIG_FILE_NAME));
    if (projectThreshold !== undefined) return projectThreshold;
  }
  return readThreshold(join(agentDir, CONFIG_FILE_NAME)) ?? DEFAULT_CONTEXT_THRESHOLD;
}

export function meetsContextThreshold(
  threshold: ContextThreshold,
  usage: ContextUsage | undefined,
): boolean {
  const current = threshold.unit === "percent" ? usage?.percent : usage?.tokens;
  return current !== undefined && current !== null && current >= threshold.value;
}
