# pi-idle-check

`pi-idle-check` is a standalone [Pi](https://pi.dev) extension that protects the next typed prompt after a long idle interval and meaningful context use. It can send against the current context, compact before sending, or move the prompt into a blank new session.

## Behavior

The dialog is eligible only when all of these are true:

- the active session contains a completed assistant response;
- Pi is in interactive TUI mode and receives typed user input;
- Pi has fully settled, including tools, retries, automatic compaction, and queued continuations;
- observable idle time is strictly greater than 180,000 milliseconds; and
- Pi reports known context usage at or above the configured threshold.

At 180,000 milliseconds or less, the extension never opens the dialog. User terminal activity before the threshold restarts the idle interval. Once the interval has crossed the threshold, eligibility latches so returning and typing a prompt does not erase the warning.

The dialog reports actual idle time as a snapshot, floored to whole seconds: for example, `6m34s`, `6m0s`, or `2h6m34s`. Hours are not limited to 23. It then accepts these keys directly:

- **Enter — send** lets the original prompt continue unchanged against the current context.
- **`c` — compact + send** withholds the prompt, runs Pi's normal manual compaction, and submits the exact text and images once compaction succeeds.
- **`C` — new session + send** creates a blank, unparented session and submits the exact prompt there after session replacement completes.
- **Escape or Ctrl-C — cancel** sends nothing and restores the prompt text to the editor.

Skill commands and prompt templates retain normal expansion in both replay paths. Extension-injected replay bypasses the gate, preventing recursion.

A dialog, compaction, session replacement, or replay failure fails closed: the prompt is not submitted twice, an error is shown, and prompt text is restored in the active editor when Pi's public UI permits. If another draft appeared meanwhile, both texts are retained. Pi's public editor API cannot restore image attachments after cancellation or failure.

No dialog appears for new or assistant-less sessions, unknown context usage, usage below threshold, active/streaming agents, steering or follow-up messages, print/JSON/RPC modes, RPC input, or extension-injected input.

## Context threshold configuration

The default threshold is 5% of the active model's context window. Configuration is read at session start from:

1. `~/.pi/agent/pi-idle-check.json` (more precisely, Pi's `getAgentDir()`);
2. `.pi/pi-idle-check.json` in a trusted project, which overrides the global file.

Use a percentage string:

```json
{"contextThreshold":"5%"}
```

Percentages may be positive decimals through 100%. Or use a positive integer token count:

```json
{"contextThreshold":50000}
```

A missing file uses the next available scope or the 5% default. A malformed or unreadable effective file produces a clear error and disables interception for that session rather than guessing. Changes take effect after `/reload` or another session start; files are not watched live.

Percentage comparison uses `ctx.getContextUsage().percent`; absolute comparison uses `ctx.getContextUsage().tokens`. Equality meets the threshold.

## Idle and resume semantics

The extension starts idle time at `agent_settled`, not at the beginning of a model response. Raw TUI input is the observable user-activity boundary. Activity after the threshold latches a pending decision; the displayed duration still measures from the same idle origin. A successful model run or compaction starts a fresh interval.

On startup, reload, resume, or fork, the extension inspects at most 64 parent-linked entries from the active session leaf. Ordinary session entries count as observable activity; background extension state and custom context entries do not. If that bounded tail contains no completed assistant response, the extension fails closed and does not prompt. The extension writes no session records and never modifies configuration.

External operating-system activity and Pi behavior that the public extension API does not expose are outside this boundary.

## Compatibility

Version 0.1.x supports `@earendil-works/pi-coding-agent` versions `>=0.84.3 <0.85.0`; it is tested against 0.84.3. Node.js 22.19.0 or newer is required.

The package ships erasable TypeScript directly. It has no build step and no runtime dependencies; Pi supplies the declared coding-agent and TUI host peers.

## Installation

The deployed installation is Nix-managed. For development from a reviewed checkout:

```sh
pi install /absolute/path/to/pi-idle-check
pi list
```

Run `/reload` or start a fresh Pi process after changing installed source or configuration. There is no npm release.

## Privacy and cost

`pi-idle-check` makes no network requests and does not persist prompt content. Compaction and prompt submission use Pi's configured model provider in the ordinary way. Provider cache behavior and actual cost savings remain provider-specific; the extension only enforces the gate and selected action described above.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run pack:check
npm run check
```

Development dependencies are exact-pinned. Tests use isolated public Pi APIs and the faux provider; they make no paid or network model calls.

## Removal

Remove the configured package source or Nix gallery entry and run `/reload`. The extension owns no persisted state to migrate or delete. User-created `pi-idle-check.json` files may be removed separately.
