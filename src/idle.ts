import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const IDLE_THRESHOLD_MS = 180_000;

export type SessionIdleSeed = {
  hasConversation: boolean;
  lastActivityAt: number | undefined;
};

export function getSessionIdleSeed(entries: readonly SessionEntry[]): SessionIdleSeed {
  let hasConversation = false;
  let lastActivityAt: number | undefined;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") hasConversation = true;
    if (entry.type === "custom" || entry.type === "custom_message") continue;

    const timestamp = Date.parse(entry.timestamp);
    if (Number.isFinite(timestamp) && (lastActivityAt === undefined || timestamp > lastActivityAt)) {
      lastActivityAt = timestamp;
    }
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
