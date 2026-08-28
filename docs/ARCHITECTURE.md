# Architecture and non-functional invariants

This document explains the boundaries that keep Pi Agent responsive, testable, and safe inside VS
Code. It describes implementation constraints, not user instructions.

Start with the [README](../README.md) for product behavior, the
[contribution guide](../CONTRIBUTING.md) for verification, and the
[security policy](../SECURITY.md) for reporting and data-handling rules.

## Runtime boundaries

```text
VS Code commands / SecretStorage / workspace.fs
                    │
                    ▼
Extension Host ── ChatWorkspaceModel ── PiHostService ── Pi SDK / provider
      │                    │                    │
      │ validated protocol│                    └─ tool authorization gate
      ▼                    ▼
Webview CSP ─────── Preact state ─────── sanitized Markdown and Mermaid
```

The Extension Host is the authority for workspace access, secrets, links, edits, session state, and
tool approvals. The Webview is a presentation process. It receives bounded display data and sends
only intents validated by the shared Valibot protocol. A UI control is never an authorization
boundary by itself.

## Security invariants

1. Provider keys stay in VS Code `SecretStorage` and are injected into the Pi model runtime without
   crossing the Webview bridge.
2. Restricted Mode forces Plan mode and exposes only read-only Pi tools. Runtime guards remain in
   place even when a contributed command is invoked directly.
3. Context accepts local `file` URIs inside an open workspace. Real-path checks reject symbolic-link
   escapes, and resolution rechecks containment immediately before reading.
4. Every bridge message is versioned, size-bounded, variant-checked, and replay-limited. References
   use opaque IDs with epochs instead of accepting arbitrary paths from rendered Markdown.
5. The Webview uses a deny-by-default CSP, one nonce-bearing local module bundle, disabled command
   URIs/forms, and a local resource root limited to its compiled assets.
6. Model errors and tool payloads pass through bounded redaction before they can reach logs or UI.

Workspace Trust also governs executable Pi project resources. In a trusted workspace, the Pi
resource loader can load project extensions whose initialization and event handlers run as
Extension Host code and can use Node.js APIs directly. Plan mode constrains Pi tool calls; it is not
a sandbox for trusted project extension modules. Restricted Mode is therefore the boundary for an
unreviewed repository, not merely a default value for the approval selector.

Trust is captured when the Extension Host starts; a live restricted Pi runtime is never elevated in
place. When VS Code grants Workspace Trust, the extension synchronously keeps its UI and permission
router in Plan, shows a short notice, and requests one window reload. If that command fails, the
current host remains restricted and asks the user to reload manually. VS Code applies trust
revocation through a window reload; the next activation constructs read-only sessions and restores
saved tabs in Plan before publishing Webview state.

Changes to these rules need tests for malformed input and for the denied path, not only the happy
path. Follow the official
[VS Code Webview security guidance](https://code.visualstudio.com/api/extension-guides/webview#security)
and [Workspace Trust guidance](https://code.visualstudio.com/api/extension-guides/workspace-trust).

## Request and event data flow

The prose below is the authoritative flow; the diagram above is only a summary.

1. A Preact component sends an intent through `src/webview/bridge.ts`. The envelope contains the
   shared protocol version and a unique request ID. For `sendPrompt`, the Composer immediately stages
   a user card under that same ID instead of waiting for an Extension Host round trip.
2. `ChatViewProvider` validates the discriminated Valibot schema, rejects replayed request IDs, and
   dispatches the typed intent. No component calls VS Code or the Pi SDK directly.
3. For a prompt, `ChatWorkspaceModel` records and publishes the user message with the wire request ID
   before resolving selected context again in `ContextStore`. Files are canonicalized, checked against
   the local workspace, size-bounded, and wrapped with the user request in a structured prompt that
   marks attachments as untrusted data. A host snapshot carrying the same ID replaces the optimistic
   Webview card without duplication.
4. The tab's `ChatSessionController` forwards the typed request to the shared `PiHostService`, which
   owns the Pi model runtime and one SDK runtime per open chat session.
5. Pi `AgentSessionEvent` values pass through `event-mapper.ts`. This adapter bounds strings, redacts
   secret-shaped values, and emits extension-owned DTOs rather than SDK objects.
6. `ChatSessionController` drops events for another session or an older generation.
   `ChatWorkspaceModel` then updates messages, phase, tools, edits, model state, and live usage.
   Thinking deltas accumulate on the assistant message as a bounded `thought` field. The status
   label stays a rule-based Japanese summary and does not include chain-of-thought.
7. `ChatViewProvider` serializes and coalesces snapshot work, validates the Host-to-Webview schema,
   and posts the latest `AppSnapshot`. The Webview store applies it and Preact renders the result.

`src/shared/protocol.ts` is the wire contract in both directions. A new action starts there and must
update its host dispatcher, Webview caller, and positive and negative protocol tests together.
Breaking wire changes require an explicit `PROTOCOL_VERSION` decision.

The model picker keeps provider, model, and reasoning changes as one Webview-local draft. One validated
`applyModelSettings` intent reaches `ChatWorkspaceModel`, which validates model capabilities before
`ChatSessionController` applies the model and reasoning in order. When requested, the same operation
persists both defaults. This avoids racing independent messages and prevents a pending selection from
being mistaken for the current default.

## Session and tool lifecycle

Extension activation creates one `PiHostService`, model runtime, workspace model, permission router,
and view provider. Each chat record owns one `ChatSessionController`; the host owns the corresponding
Pi runtime. `SessionRegistry` prevents two tabs from owning the same canonical session file.

Session replacement, fork, reload, and close are serialized. Rebinding increments a generation, so
late events from the previous Pi session cannot mutate the current tab. Abort clears queued prompts,
compaction, branch summaries, and shell work before closing the SDK runtime.

Tool events follow a separate turn lifecycle:

1. `tool.start`, `tool.update`, and `tool.end` update `TurnToolTracker` by tool-call ID and assistant
   message owner. Live rounds stay inspectable while the agent is working.
2. Retry and compaction restore transient tool panels because the same turn can continue.
3. Authoritative `agent.settled`, user Stop, or session close performs final settlement. Running tools
   become cancelled, duplicate IDs collapse, tool-only rows are pruned, and the final assistant
   message owns one `Tools N件` disclosure.
4. `edit` and `write` additionally capture bounded before/after text around the authorized tool call.
   `ProposedEditStore` keeps the resulting diff in memory for VS Code review.

Live usage overlays the latest message usage on the last confirmed SDK totals. Preview publication is
throttled, while confirmed message/tool/settle boundaries reset it. The UI separates current-context
usage and remaining capacity from exact cumulative session tokens. Cost remains a catalog-price
estimate even for subscriptions; unknown catalog pricing is the only unavailable state. Compaction is
disabled in the Webview while a response or approval is active, and the host independently enforces the
same idle-session requirement.

## Tool permission flow

The authorization extension is installed last in each Pi session so extension-contributed tool calls
also pass through the host policy.

1. `tool-authorization.ts` resolves paths like Pi, canonicalizes the nearest existing parent, checks
   workspace and symlink boundaries, and classifies safe, sensitive, or dangerous risk.
   A narrow exception permits only the built-in `read` tool to inspect the canonical, package-owned
   Pi README/docs/examples advertised by Pi's system prompt; mutation, execution, symlink escape,
   and arbitrary extension-install paths do not inherit that exception.
2. `extension.ts` maps the tool request to a capability such as workspace read/search/edit/write,
   command execution, secret read, or outside-workspace access.
3. `ToolAuthorizationRouter` binds the request to a chat and asks the pure `PermissionBroker` policy.
4. An `ask` result becomes one pending approval card with a five-minute timeout. The response is
   accepted only for the originating request and chat.
5. Allow once resolves only that call. Allow for session records only a normal-risk signature;
   dangerous calls cannot become session grants. Deny and reset fail closed.

Plan denies mutation and execution. Ask confirms them. Auto Edit allows normal workspace edits and
ordinary commands without per-command confirmation, but confirms deletion, dangerous commands, and
higher-risk boundaries. Full Access allows critical operations, including known dangerous commands,
without per-command confirmation; directly classified secret and outside-workspace boundaries still
ask, but indirect command effects cannot be classified reliably. Restricted Mode fixes the UI to Plan
and also limits the SDK's available tools, so the UI selector is not the enforcement boundary.

## Retained data and ownership

| Data | Owner and lifetime |
| --- | --- |
| Provider API keys | VS Code `SecretStorage`; never included in Webview state |
| Provider IDs | Extension global state, without credential values |
| Tab metadata | Workspace state: title, model IDs, thinking, session file reference, approval mode (Full Access is saved as Ask) |
| Pi transcript | Pi SDK agent data directory and session manager |
| Context chips | Extension Host memory; file contents are resolved again for every prompt |
| View Design | Global or workspace state; global design is eligible for Settings Sync |
| Edit-review diffs | Extension Host memory; LRU-evicted at 32 records or 32 MiB and cleared on disposal |
| Active Webview tab hint | Webview state containing only the chat ID |

Full Access is deliberately persisted as Ask. Prompt text, responses, tool results, and attachment
content may remain in the Pi transcript; see the [Security Policy](../SECURITY.md) for user-facing
storage, reporting, and telemetry rules.

## Lifecycle and ownership

- Extension activation owns the shared Pi host, output channel, workspace model, stores, permission
  router, and view provider through `ExtensionContext.subscriptions`.
- Each chat record owns one `ChatSessionController` and its Pi-event subscription.
- Closing a chat cancels pending approval requests, stops or backgrounds work according to the user
  decision, closes the session, and removes authorization state.
- Each resolved Webview owns its receive/visibility/dispose subscriptions. Re-resolving or disposing
  the view tears down the previous set before installing another.
- Snapshot publication is serialized and coalesced: high-frequency events retain at most one
  trailing refresh instead of creating an unbounded async queue.
- Timers are cleared by their owner. Long-running SDK operations expose abort or close paths.

## Performance budgets

- Model streaming UI refreshes are debounced; statistics previews are throttled by the Pi host.
- Protocol arrays, messages, tool details, prompts, images, context bytes, folder traversal, and
  retained replay IDs all have explicit upper bounds. Assistant thought text is truncated before
  answer text when a message exceeds the per-message budget. Context resolution is capped at 8 MiB and
  2,048 aggregate attachment records; one configured folder can still contribute up to 2,000
  files before the shared byte and metadata budgets apply.
- The current snapshot contains only the active chat history. Inactive tabs keep lightweight status
  metadata in the Webview; selecting a tab triggers an immediate snapshot with that chat's history.
- Markdown and Mermaid rendering must remain local. The CSP denies network connections and remote
  image requests.
- The verified VSIX budget is 6,500 files, 16 MiB compressed, and 55 MiB unpacked. Raising a budget
  requires an explanation of the shipped runtime need.

## Testing strategy

| Layer | Purpose |
| --- | --- |
| Pure unit tests | Permission policy, parsers, sanitizers, state transitions, usage math, coalescing |
| Protocol tests | Accept supported intents and reject malformed, oversized, or unsafe input |
| Component contracts | Keyboard/ARIA, reduced motion, narrow layout, sanitized rich rendering |
| Extension Host tests | Activation, public command registration, and real VS Code link behavior |
| Package verification | Runtime assets, forbidden dev/secret files, rewritten links, dependency licenses, path and size budgets |

The packaged-extension test unpacks the VSIX, imports the shipped Pi SDK without optional native
clipboard packages, verifies the SDK's README/docs/examples paths, and activates that unpacked
extension in a real VS Code Extension Host. This catches runtime omissions that a development-tree
activation cannot detect.

Source-text assertions are acceptable for static CSS/markup contracts but should not substitute for
behavioral tests of state, concurrency, authorization, parsing, or resource cleanup.

## Change map

- Add a bridge action: update `src/shared/protocol.ts`, host dispatch, Webview caller, protocol tests,
  and any relevant authorization test.
- Add a tool capability: update Pi event DTOs, the authorization gate, capability mapping, policy
  tests, approval copy, and Restricted Mode coverage.
- Add retained state: define its owner, maximum size, schema/migration, disposal behavior, and
  whether it may contain sensitive data.
- Add a dependency: explain why platform APIs are insufficient, audit it, verify its license, and
  inspect the resulting VSIX.
