import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const IDLE_THRESHOLD_MS = 300_000;
export const SESSION_LOOKBACK_LIMIT = 64;

export function formatIdleDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h${minutes}m${seconds}s`
    : `${Math.floor(totalSeconds / 60)}m${seconds}s`;
}

export type SessionIdleSeed = {
  hasConversation: boolean;
  lastActivityAt: number | undefined;
};

export function getSessionIdleSeed(
  sessionManager: Pick<ExtensionContext["sessionManager"], "getLeafEntry" | "getEntry">,
): SessionIdleSeed {
  let entry = sessionManager.getLeafEntry();
  let hasConversation = false;
  let lastActivityAt: number | undefined;

  for (let inspected = 1; entry !== undefined; inspected++) {
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason !== "pending" &&
      entry.message.stopReason !== "deferred"
    ) {
      hasConversation = true;
    }

    if (lastActivityAt === undefined && entry.type !== "custom" && entry.type !== "custom_message") {
      const timestamp = Date.parse(entry.timestamp);
      if (Number.isFinite(timestamp)) lastActivityAt = timestamp;
    }

    if (hasConversation && lastActivityAt !== undefined) break;
    if (inspected === SESSION_LOOKBACK_LIMIT) break;

    entry = entry.parentId === null ? undefined : sessionManager.getEntry(entry.parentId);
  }

  return { hasConversation, lastActivityAt };
}

export class IdleTracker {
  private hasConversation = false;
  private lastActivityAt: number | undefined;
  private latched = false;

  seed(lastActivityAt: number | undefined, hasConversation: boolean): void {
    this.hasConversation = hasConversation;
    this.lastActivityAt =
      lastActivityAt !== undefined && Number.isFinite(lastActivityAt) ? lastActivityAt : undefined;
    this.latched = false;
  }

  observeUserActivity(now: number, thresholdMs = IDLE_THRESHOLD_MS): void {
    if (!this.hasConversation || this.lastActivityAt === undefined || this.latched) return;
    if (now - this.lastActivityAt > thresholdMs) {
      this.latched = true;
    } else {
      this.lastActivityAt = now;
    }
  }

  getPromptIdleDuration(now: number, thresholdMs = IDLE_THRESHOLD_MS): number | undefined {
    if (!this.hasConversation || this.lastActivityAt === undefined) return undefined;
    const elapsed = now - this.lastActivityAt;
    if (this.latched || elapsed > thresholdMs) {
      this.latched = true;
      return Math.max(0, elapsed);
    }
    return undefined;
  }

  shouldPrompt(now: number, thresholdMs = IDLE_THRESHOLD_MS): boolean {
    return this.getPromptIdleDuration(now, thresholdMs) !== undefined;
  }

  markActive(): void {
    this.lastActivityAt = undefined;
    this.latched = false;
  }

  markSettled(now: number): void {
    this.hasConversation = true;
    this.lastActivityAt = now;
    this.latched = false;
  }

  reset(): void {
    this.hasConversation = false;
    this.lastActivityAt = undefined;
    this.latched = false;
  }
}
