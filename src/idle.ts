import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const IDLE_THRESHOLD_MS = 180_000;
export const SESSION_LOOKBACK_LIMIT = 64;

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

  observeUserActivity(now: number): void {
    if (!this.hasConversation || this.lastActivityAt === undefined || this.latched) return;
    if (now - this.lastActivityAt > IDLE_THRESHOLD_MS) {
      this.latched = true;
    } else {
      this.lastActivityAt = now;
    }
  }

  shouldPrompt(now: number): boolean {
    if (!this.hasConversation || this.lastActivityAt === undefined) return false;
    if (this.latched || now - this.lastActivityAt > IDLE_THRESHOLD_MS) {
      this.latched = true;
      return true;
    }
    return false;
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
