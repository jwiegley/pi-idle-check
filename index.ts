import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getSessionIdleSeed, IdleTracker } from "./src/idle.ts";

export { getSessionIdleSeed, IDLE_THRESHOLD_MS, IdleTracker } from "./src/idle.ts";

export const COMPACT_AND_SEND = "Compact, then send";
export const SEND_WITHOUT_COMPACTING = "Send without compacting";
export const CANCEL = "Cancel";

type PiIdleCheckOptions = {
  now?: () => number;
};

function restorePrompt(ui: ExtensionUIContext, prompt: string): void {
  const draft = ui.getEditorText();
  if (draft === prompt) return;
  ui.setEditorText(draft.length === 0 ? prompt : `${prompt}\n${draft}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPiIdleCheck(options: PiIdleCheckOptions = {}): (pi: ExtensionAPI) => void {
  const now = options.now ?? Date.now;

  return (pi: ExtensionAPI): void => {
    const tracker = new IdleTracker();
    let removeTerminalListener: (() => void) | undefined;

    pi.on("session_start", (_event, ctx) => {
      removeTerminalListener?.();
      const seed = getSessionIdleSeed(ctx.sessionManager);
      tracker.seed(seed.lastActivityAt, seed.hasConversation);

      removeTerminalListener =
        ctx.mode === "tui"
          ? ctx.ui.onTerminalInput(() => {
              if (ctx.isIdle()) tracker.observeUserActivity(now());
              return undefined;
            })
          : undefined;
    });

    pi.on("session_shutdown", () => {
      removeTerminalListener?.();
      removeTerminalListener = undefined;
      tracker.reset();
    });

    pi.on("agent_start", () => {
      tracker.markActive();
    });

    pi.on("agent_settled", () => {
      tracker.markSettled(now());
    });

    pi.on("session_compact", () => {
      tracker.markSettled(now());
    });

    pi.on("input", async (event, ctx) => {
      if (
        event.source !== "interactive" ||
        event.streamingBehavior !== undefined ||
        ctx.mode !== "tui" ||
        !ctx.hasUI ||
        !ctx.isIdle()
      ) {
        return { action: "continue" };
      }

      const timestamp = now();
      if (!tracker.shouldPrompt(timestamp)) {
        tracker.observeUserActivity(timestamp);
        return { action: "continue" };
      }

      let choice: string | undefined;
      try {
        choice = await ctx.ui.select("Session idle for more than 3 minutes", [
          COMPACT_AND_SEND,
          SEND_WITHOUT_COMPACTING,
          CANCEL,
        ]);
      } catch (error) {
        restorePrompt(ctx.ui, event.text);
        ctx.ui.notify(`Idle check failed; prompt was not sent: ${describeError(error)}`, "error");
        return { action: "handled" };
      }

      if (choice === SEND_WITHOUT_COMPACTING) return { action: "continue" };

      if (choice !== COMPACT_AND_SEND) {
        restorePrompt(ctx.ui, event.text);
        return { action: "handled" };
      }

      const content: Parameters<ExtensionAPI["sendUserMessage"]>[0] = event.images?.length
        ? [{ type: "text", text: event.text }, ...event.images]
        : event.text;

      try {
        ctx.compact({
          onComplete: () => {
            pi.sendUserMessage(content, { expandPromptTemplates: true });
          },
          onError: (error) => {
            restorePrompt(ctx.ui, event.text);
            ctx.ui.notify(`Compaction failed; prompt was not sent: ${error.message}`, "error");
          },
        });
      } catch (error) {
        restorePrompt(ctx.ui, event.text);
        ctx.ui.notify(`Compaction failed; prompt was not sent: ${describeError(error)}`, "error");
      }

      return { action: "handled" };
    });
  };
}

export default createPiIdleCheck();
