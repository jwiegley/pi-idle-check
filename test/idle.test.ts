import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSessionIdleSeed, IDLE_THRESHOLD_MS, IdleTracker } from "../src/idle.ts";

test("uses a fixed three-minute threshold", () => {
  assert.equal(IDLE_THRESHOLD_MS, 180_000);
});

test("requires strictly more than the threshold", () => {
  for (const [elapsed, expected] of [
    [179_999, false],
    [180_000, false],
    [180_001, true],
  ] as const) {
    const tracker = new IdleTracker();
    tracker.seed(1_000, true);
    assert.equal(tracker.shouldPrompt(1_000 + elapsed), expected, `${elapsed}ms`);
  }
});

test("does not prompt without a prior conversation", () => {
  const tracker = new IdleTracker();
  tracker.seed(0, false);
  assert.equal(tracker.shouldPrompt(IDLE_THRESHOLD_MS + 1), false);
});

test("pre-threshold user activity restarts idle time", () => {
  const tracker = new IdleTracker();
  tracker.seed(0, true);
  tracker.observeUserActivity(179_999);
  assert.equal(tracker.shouldPrompt(180_001), false);
  assert.equal(tracker.shouldPrompt(179_999 + IDLE_THRESHOLD_MS + 1), true);
});

test("activity after threshold latches the pending decision", () => {
  const tracker = new IdleTracker();
  tracker.seed(0, true);
  tracker.observeUserActivity(180_001);
  tracker.observeUserActivity(180_002);
  assert.equal(tracker.shouldPrompt(180_002), true);
});

test("model activity clears a latch until the run settles", () => {
  const tracker = new IdleTracker();
  tracker.seed(0, true);
  assert.equal(tracker.shouldPrompt(180_001), true);

  tracker.markActive();
  assert.equal(tracker.shouldPrompt(900_000), false);

  tracker.markSettled(900_000);
  assert.equal(tracker.shouldPrompt(1_080_000), false);
  assert.equal(tracker.shouldPrompt(1_080_001), true);
});

test("resume seed uses persisted session activity and ignores extension state entries", () => {
  const entries = [
    {
      type: "message",
      id: "assistant",
      parentId: null,
      timestamp: new Date(10_000).toISOString(),
      message: { role: "assistant" },
    },
    {
      type: "label",
      id: "label",
      parentId: "assistant",
      timestamp: new Date(20_000).toISOString(),
      targetId: "assistant",
      label: "important",
    },
    {
      type: "custom",
      id: "background-state",
      parentId: "label",
      timestamp: new Date(30_000).toISOString(),
      customType: "background",
    },
  ] as unknown as SessionEntry[];

  assert.deepEqual(getSessionIdleSeed(entries), {
    hasConversation: true,
    lastActivityAt: 20_000,
  });
});

test("resume seed requires a completed assistant message", () => {
  const entries = [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: new Date(10_000).toISOString(),
      message: { role: "user" },
    },
  ] as unknown as SessionEntry[];

  assert.deepEqual(getSessionIdleSeed(entries), {
    hasConversation: false,
    lastActivityAt: 10_000,
  });
});
