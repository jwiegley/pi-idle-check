# pi-idle-check

`pi-idle-check` is a standalone [Pi](https://pi.dev) extension that protects the next typed prompt after a long idle interval and meaningful context use. It can send against the current context, compact before sending, or move the prompt into a blank new session.

```text
Session idle for 6m34s; 25.4% context exceeds 5%
Enter send · c compact + send · C new session + send · Esc cancel
```

## Installation

Requires Node.js 22.19.0 or newer and Pi `>=0.84.3 <0.85.0` (tested against 0.84.3).

Install from npm:

```sh
pi install npm:pi-idle-check
```

For development, install from a reviewed Git checkout:

```sh
pi install /absolute/path/to/pi-idle-check
pi list
```

Run `/reload` or restart Pi after installation. Default settings need no configuration. Avoid loading both a Nix-managed copy and an npm or local copy.

Licensed under [MIT](LICENSE). See [Publishing](https://github.com/jwiegley/pi-idle-check/blob/main/PUBLISHING.md) for npm account setup, the release procedure, and catalog requirements.

## Behavior

The dialog is eligible only when all of these are true:

- idle checks are enabled for the active provider and model;
- the active session contains a completed assistant response;
- Pi is in interactive TUI mode and receives typed user input;
- Pi has fully settled, including tools, retries, automatic compaction, and queued continuations;
- observable idle time is strictly greater than the configured idle delay (five minutes by default); and
- Pi reports known context usage at or above the configured threshold.

At the configured delay or less, the extension never opens the dialog. User terminal activity before the threshold restarts the idle interval. Once the interval has crossed the threshold, eligibility latches so returning and typing a prompt does not erase the warning.

The dialog reports actual idle time as a snapshot, floored to whole seconds: for example, `6m34s`, `6m0s`, or `2h6m34s`. Hours are not limited to 23. The same line reports current context usage in the configured threshold's unit, for example `25.4% context exceeds 5%` or `285k context exceeds 50k`. Current percentage usage uses one decimal place, matching Pi's footer; the configured threshold remains exact. Equality uses `meets`; token values that are exact multiples of 1,000 use lowercase `k`, while other values remain exact. It then accepts these keys directly:

- **Enter — send** lets the original prompt continue unchanged against the current context. If the agent starts while the dialog is open, the prompt is re-sent as steering.
- **`c` — compact + send** withholds the prompt, runs Pi's normal manual compaction, and submits the exact text and images once compaction succeeds.
- **`C` — new session + send** creates a blank, unparented session and submits the exact prompt there after session replacement completes.
- **Escape or Ctrl-C — cancel** sends nothing and restores the prompt text to the editor.

Skill commands and prompt templates retain normal expansion in both replay paths. Extension-injected replay bypasses the gate, preventing recursion.

A dialog, compaction, session replacement, or replay failure fails closed: the prompt is not submitted twice, an error is shown, and prompt text is restored in the active editor when Pi's public UI permits. If another draft appeared meanwhile, both texts are retained. Pi's public editor API cannot restore image attachments after cancellation or failure.

Active/streaming input bypasses the dialog: Return remains steering, while Alt-Return remains follow-up. No dialog appears for new or assistant-less sessions, unknown context usage, usage below threshold, print/JSON/RPC modes, RPC input, or extension-injected input.

## Configuration

Configuration is read at session start from:

1. `~/.pi/agent/pi-idle-check.json` (more precisely, Pi's `getAgentDir()`);
2. `.pi/pi-idle-check.json` in a trusted project.

The agent-global file is the base. A trusted project file merges over it: scalar settings replace global values only when present, and entries in `providers`, `models`, and `providerIdleThresholdMinutes` replace only the matching global entry. Each matching entry is replaced as a whole, not merged field by field. In `providers` and `models`, an empty `{}` entry restores inheritance from less-specific settings. Changes take effect after `/reload` or another session start; files are not watched live. A malformed or unreadable configured file produces a clear error and disables interception for that session rather than guessing.

### Idle delay

The built-in idle delay is five minutes. Set `idleThresholdMinutes` to a positive whole number to change the default delay. The existing `providerIdleThresholdMinutes` setting remains supported; new configurations can use `providers` below to override both limits together.

```json
{
  "idleThresholdMinutes": 3,
  "providerIdleThresholdMinutes": {
    "openai-codex": 10
  }
}
```

This example waits three minutes for other providers and ten minutes for `openai-codex`. Missing configuration uses the five-minute built-in default.

### Context threshold

The default threshold is 5% of the active model's context window. Set `contextThreshold` to an integer percentage from 1 through 100:

```json
{"contextThreshold":10}
```

Comparison uses `ctx.getContextUsage().percent`. Equality meets the threshold.

### Provider and model overrides

Use `providers` for exact Pi provider IDs and `models` for exact `provider/model-id` keys. Model IDs may contain additional slashes; bare model names and wildcard patterns are not supported. Each entry accepts `idleThresholdMinutes`, `contextThreshold`, and `enabled`. Thresholds have the same units and validation as the defaults above.

```json
{
  "idleThresholdMinutes": 5,
  "contextThreshold": 5,
  "providers": {
    "omlx-hera": { "enabled": false },
    "openai-codex": { "idleThresholdMinutes": 10, "contextThreshold": 20 }
  },
  "models": {
    "openai-codex/my-model-id": { "idleThresholdMinutes": 2, "contextThreshold": 10 },
    "openai-codex/another-model-id": { "enabled": false }
  }
}
```

Replace the example model IDs with the IDs configured in Pi. This configuration disables interception for every `omlx-hera` model and for `openai-codex/another-model-id`, while giving the remaining matches their specified limits.

Each setting resolves independently, from least to most specific:

1. Built-in defaults: enabled, five minutes, 5% context.
2. Top-level configuration.
3. `providerIdleThresholdMinutes` for the active provider (idle delay only).
4. The matching `providers` entry.
5. The matching `models` entry.

Omitted settings inherit from the preceding level. `enabled: false` bypasses interception entirely; a more-specific `enabled: true` can re-enable it, including for one model under a disabled provider. Top-level `enabled: false` disables checks by default. A disabled entry still requires valid thresholds if they are supplied.

Both terminal activity and prompt submission use the currently selected model. Switching models applies the matching limits immediately; a latched decision from a shorter delay does not override a longer or disabled limit.

## Idle and resume semantics

The extension starts idle time at `agent_settled`, not at the beginning of a model response. Raw TUI input is the observable user-activity boundary. Activity after the threshold latches a pending decision; the displayed duration still measures from the same idle origin. A successful model run or compaction starts a fresh interval.

On startup, reload, resume, or fork, the extension inspects at most 64 parent-linked entries from the active session leaf. Ordinary session entries count as observable activity; background extension state and custom context entries do not. If that bounded tail contains no completed assistant response, the extension fails closed and does not prompt. The extension writes no session records and never modifies configuration.

External operating-system activity and Pi behavior that the public extension API does not expose are outside this boundary.

## Compatibility

Version 0.1.x supports `@earendil-works/pi-coding-agent` versions `>=0.84.3 <0.85.0`; it is tested against 0.84.3. Node.js 22.19.0 or newer is required.

The package ships erasable TypeScript directly. It has no build step and no runtime dependencies; Pi supplies the declared coding-agent and TUI host peers.

## Privacy and cost

`pi-idle-check` makes no network requests and does not persist prompt content. Compaction and prompt submission use Pi's configured model provider in the ordinary way. Provider cache behavior and actual cost savings remain provider-specific; the extension only enforces the gate and selected action described above.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:check
npm run check
```

Development dependencies are exact-pinned. Tests use isolated public Pi APIs and the faux provider; they make no paid or network model calls. The package smoke test packs the release files, installs the tarball offline without host peers, and loads it through Pi's resource loader. `npm publish` runs `npm run check` through `prepublishOnly`; installation runs no lifecycle scripts.

## Removal

For an npm installation:

```sh
pi remove npm:pi-idle-check
```

For a local or Nix-managed installation, remove the corresponding package source or gallery entry. Run `/reload` or restart Pi afterward. The extension owns no persisted state to migrate or delete. User-created `pi-idle-check.json` files may be removed separately.
