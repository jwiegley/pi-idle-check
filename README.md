# pi-idle-check

`pi-idle-check` is a standalone [Pi](https://pi.dev) extension that pauses the next interactive prompt after strictly more than three minutes of continuous idle time and offers to compact the session first.

## Behavior

The dialog is eligible only when all of these are true:

- the active session contains a completed assistant response;
- Pi is in interactive TUI mode and receives typed user input;
- Pi has fully settled, including tools, retries, automatic compaction, and queued continuations; and
- observable idle time is greater than 180,000 milliseconds.

At 180,000 milliseconds or less, the extension never opens the dialog. User terminal activity before the threshold restarts the idle interval. Once the interval has already crossed the threshold, eligibility latches so returning and typing a prompt does not erase the warning.

The dialog has three choices:

- **Compact, then send** withholds the prompt, runs Pi's normal manual compaction, and submits the exact text and images once compaction succeeds. Skill commands and prompt templates retain normal expansion.
- **Send without compacting** lets the original prompt continue unchanged.
- **Cancel** sends nothing and restores the prompt text to the editor.

A dialog or compaction failure fails closed: no prompt is sent, the error is shown, and prompt text is restored. If another draft appeared meanwhile, both texts are retained in the editor. Image attachments are replayed exactly after successful compaction; Pi's public editor API cannot restore attachments after cancellation or failure.

No dialog appears for new or assistant-less sessions, active/streaming agents, steering or follow-up messages, print/JSON/RPC modes, RPC input, or extension-injected input. Extension-injected replay bypasses the gate, preventing recursion.

## Idle and resume semantics

The extension starts idle time at `agent_settled`, not at the beginning of a model response. Raw TUI input is the observable user-activity boundary. Activity after the threshold latches a pending decision; a successful model run or compaction starts a fresh interval.

On startup, reload, resume, or fork, the extension inspects at most 64 parent-linked entries from the active session leaf. Ordinary session entries count as observable activity; background extension state and custom context entries do not. A deeper session is treated as established without loading its full history. The extension writes no session records or mutable configuration of its own.

External operating-system activity and Pi behavior that the public extension API does not expose are outside this boundary.

## Compatibility

Version 0.1.x supports `@earendil-works/pi-coding-agent` versions `>=0.84.3 <0.85.0`; it is tested against 0.84.3. Node.js 22.19.0 or newer is required.

The package ships erasable TypeScript directly. It has no build step and no runtime dependencies.

## Installation

The deployed installation is Nix-managed. For development from a reviewed checkout:

```sh
pi install /absolute/path/to/pi-idle-check
pi list
```

Run `/reload` or start a fresh Pi process after changing the installed source. There is no npm release.

## Privacy and cost

`pi-idle-check` makes no network requests and does not retain prompt content. Choosing compaction and sending the replay use Pi's configured model provider in the ordinary way. Provider cache behavior and actual cost savings remain provider-specific; the extension only enforces the timing and choice described above.

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

Remove the configured package source or Nix gallery entry and run `/reload`. The extension owns no persisted state to migrate or delete.
