import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
  loadContextThreshold,
  meetsContextThreshold,
  type ContextThreshold,
} from "./src/config.ts";
import { formatIdleDuration, getSessionIdleSeed, IdleTracker } from "./src/idle.ts";

export {
  CONFIG_FILE_NAME,
  DEFAULT_CONTEXT_THRESHOLD,
  loadContextThreshold,
  meetsContextThreshold,
  parseContextThreshold,
  type ContextThreshold,
} from "./src/config.ts";
export { formatIdleDuration, getSessionIdleSeed, IDLE_THRESHOLD_MS, IdleTracker } from "./src/idle.ts";

export const COMPACT_AND_SEND = "Compact, then send";
export const SEND_WITHOUT_COMPACTING = "Send without compacting";
export const NEW_SESSION_AND_SEND = "New session, then send";
export const CANCEL = "Cancel";
export const NEW_SESSION_COMMAND = "pi-idle-check-new-session";

type IdlePromptChoice =
  | typeof COMPACT_AND_SEND
  | typeof SEND_WITHOUT_COMPACTING
  | typeof NEW_SESSION_AND_SEND
  | typeof CANCEL;
type PromptContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

export type PiIdleCheckOptions = {
  now?: () => number;
  contextThreshold?: ContextThreshold;
};

function restorePrompt(ui: ExtensionUIContext, prompt: string): void {
  const draft = ui.getEditorText();
  if (draft === prompt) return;
  ui.setEditorText(draft.length === 0 ? prompt : `${prompt}\n${draft}`);
}

function removeRestoredPrompt(ui: ExtensionUIContext, prompt: string): void {
  const draft = ui.getEditorText();
  if (draft === prompt) {
    ui.setEditorText("");
  } else if (draft.startsWith(`${prompt}\n`)) {
    ui.setEditorText(draft.slice(prompt.length + 1));
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failPrompt(
  ui: ExtensionUIContext,
  prompt: string,
  operation: string,
  error: unknown,
): void {
  restorePrompt(ui, prompt);
  ui.notify(`${operation} failed; prompt was not sent: ${describeError(error)}`, "error");
}

export function idlePromptChoice(data: string): IdlePromptChoice | undefined {
  if (matchesKey(data, "return")) return SEND_WITHOUT_COMPACTING;
  if (matchesKey(data, "c")) return COMPACT_AND_SEND;
  if (matchesKey(data, "shift+c")) return NEW_SESSION_AND_SEND;
  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return CANCEL;
  return undefined;
}

async function chooseIdleAction(
  ui: ExtensionUIContext,
  idleDurationMs: number,
): Promise<IdlePromptChoice | undefined> {
  return ui.custom<IdlePromptChoice | undefined>((_tui, theme, _keybindings, done) => ({
    render: () => [
      theme.fg("warning", `Session idle for ${formatIdleDuration(idleDurationMs)}; context threshold reached`),
      `${theme.bold("Enter")} send · ${theme.bold("c")} compact + send · ${theme.bold("C")} new session + send · ${theme.bold("Esc")} cancel`,
    ],
    handleInput(data) {
      const choice = idlePromptChoice(data);
      if (choice !== undefined) done(choice);
    },
    invalidate() {},
  }));
}

export function createPiIdleCheck(options: PiIdleCheckOptions = {}): (pi: ExtensionAPI) => void {
  const now = options.now ?? Date.now;

  return (pi: ExtensionAPI): void => {
    const tracker = new IdleTracker();
    let contextThreshold: ContextThreshold | undefined;
    let pendingNewSession: { content: PromptContent; prompt: string } | undefined;
    let pendingReplay: { prompt: string; ui: ExtensionUIContext } | undefined;
    let removeTerminalListener: (() => void) | undefined;

    pi.registerCommand(NEW_SESSION_COMMAND, {
      description: "Internal pi-idle-check new-session handoff",
      handler: async (_args, ctx) => {
        const pending = pendingNewSession;
        if (pending === undefined) return;
        pendingNewSession = undefined;

        try {
          const result = await ctx.newSession({
            withSession: async (replacement) => {
              try {
                await replacement.sendUserMessage(pending.content, { expandPromptTemplates: true });
              } catch (error) {
                failPrompt(replacement.ui, pending.prompt, "New-session replay", error);
              }
            },
          });
          if (result.cancelled) {
            restorePrompt(ctx.ui, pending.prompt);
            ctx.ui.notify("New session was cancelled; prompt was not sent", "warning");
          }
        } catch (error) {
          try {
            failPrompt(ctx.ui, pending.prompt, "New session", error);
          } catch {
            throw error;
          }
        }
      },
    });

    pi.on("session_start", (_event, ctx) => {
      removeTerminalListener?.();
      try {
        contextThreshold =
          options.contextThreshold ?? loadContextThreshold(ctx.cwd, ctx.isProjectTrusted());
      } catch (error) {
        contextThreshold = undefined;
        ctx.ui.notify(`Idle check disabled: ${describeError(error)}`, "error");
      }

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
      contextThreshold = undefined;
      pendingNewSession = undefined;
      pendingReplay = undefined;
      tracker.reset();
    });

    pi.on("agent_start", () => {
      if (pendingReplay !== undefined) {
        removeRestoredPrompt(pendingReplay.ui, pendingReplay.prompt);
        pendingReplay = undefined;
      }
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
        !ctx.hasUI
      ) {
        return { action: "continue" };
      }

      const content: PromptContent = event.images?.length
        ? [{ type: "text", text: event.text }, ...event.images]
        : event.text;
      const sendAsSteer = (): { action: "handled" } => {
        try {
          pi.sendUserMessage(content, { deliverAs: "steer", expandPromptTemplates: true });
        } catch (error) {
          failPrompt(ctx.ui, event.text, "Steering", error);
        }
        return { action: "handled" };
      };

      if (!ctx.isIdle()) return sendAsSteer();

      const timestamp = now();
      const idleDurationMs = tracker.getPromptIdleDuration(timestamp);
      if (idleDurationMs === undefined) {
        tracker.observeUserActivity(timestamp);
        return { action: "continue" };
      }
      if (
        contextThreshold === undefined ||
        !meetsContextThreshold(contextThreshold, ctx.getContextUsage())
      ) {
        return { action: "continue" };
      }

      let choice: IdlePromptChoice | undefined;
      try {
        choice = await chooseIdleAction(ctx.ui, idleDurationMs);
      } catch (error) {
        failPrompt(ctx.ui, event.text, "Idle check", error);
        return { action: "handled" };
      }

      if (choice === SEND_WITHOUT_COMPACTING) {
        return ctx.isIdle() ? { action: "continue" } : sendAsSteer();
      }

      if (choice === CANCEL || choice === undefined) {
        restorePrompt(ctx.ui, event.text);
        return { action: "handled" };
      }

      if (choice === NEW_SESSION_AND_SEND) {
        const pending = { content, prompt: event.text };
        pendingNewSession = pending;
        // Session replacement is command-only, so let this input handler unwind before dispatch.
        setTimeout(() => {
          if (pendingNewSession !== pending) return;
          try {
            pi.sendUserMessage(`/${NEW_SESSION_COMMAND}`, { expandPromptTemplates: true });
          } catch (error) {
            pendingNewSession = undefined;
            try {
              failPrompt(ctx.ui, pending.prompt, "New-session dispatch", error);
            } catch {
              // Session replacement may already have invalidated the old UI.
            }
          }
        }, 0);
        return { action: "handled" };
      }

      try {
        ctx.compact({
          onComplete: () => {
            // Keep the text recoverable until agent_start confirms replay passed preflight.
            pendingReplay = { prompt: event.text, ui: ctx.ui };
            restorePrompt(ctx.ui, event.text);
            try {
              pi.sendUserMessage(content, { expandPromptTemplates: true });
            } catch (error) {
              pendingReplay = undefined;
              failPrompt(ctx.ui, event.text, "Compaction replay", error);
            }
          },
          onError: (error) => {
            failPrompt(ctx.ui, event.text, "Compaction", error);
          },
        });
      } catch (error) {
        failPrompt(ctx.ui, event.text, "Compaction", error);
      }

      return { action: "handled" };
    });
  };
}

export default createPiIdleCheck();
