# Contributing to Pi Agent for VS Code

Thank you for improving Pi Agent. This guide is the shortest path from a clean checkout to a
verified VSIX.

## Prerequisites

- Visual Studio Code 1.106 or newer
- Node.js 22.19 or newer
- Bun 1.3.14 (the version pinned in `package.json`)
- macOS, Linux, or Windows with a local filesystem workspace

Install the recommended VS Code extension when prompted. The workspace-pinned TypeScript 7 package
and VS Code's `js/ts.experimental.useTsgo` setting provide the Go language service; Biome supplies
formatting and lint feedback.

## Set up once

```sh
bun ci
bun run check
```

`bun ci` installs exactly the versions recorded in `bun.lock`. If it reports that the lockfile and
manifest disagree, update both together rather than bypassing the frozen install.

## Daily commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Rebuild the extension and Webview when `src/` changes |
| `bun run lint` | Check Biome formatting, lint rules, and imports |
| `bun run typecheck` | Run strict TypeScript without emitting files |
| `bun run test:unit` | Run all tests except Extension Host integration tests |
| `bun run audit:dependencies` | Reject known high-severity dependency vulnerabilities |
| `bun run package:list` | Inspect the files that VSCE plans to ship |
| `bun run test:package` | Unpack the current VSIX and test its shipped Extension Host runtime |

## Develop and debug

1. Run `bun run dev` to rebuild when source files change.
2. Press `F5` in VS Code and use the **Run Pi Agent** launch configuration.
3. Open a local test workspace in the Extension Development Host.
4. Inspect **Output → Pi Agent** for lifecycle errors. Logs intentionally omit prompt bodies,
   credentials, and tool payloads.

The main code areas are:

| Area | Responsibility |
| --- | --- |
| `src/extension/pi` | Pi SDK sessions, model runtime, event mapping, sanitization |
| `src/extension/views` | Workspace model and the validated Webview bridge |
| `src/extension/permissions` | Approval policy and one-shot tool authorization |
| `src/extension/context` | Size-bounded, workspace-contained context resolution |
| `src/webview` | Preact interface, rich Markdown, keyboard and responsive behavior |
| `src/shared` | Runtime-validated protocol and shared domain types |

See [the architecture notes](docs/ARCHITECTURE.md) before changing a trust boundary or lifecycle.

## Required verification

Run the narrowest relevant test while iterating, then run all gates before handing off a change:

```sh
bun run check
bun run test:integration
bun run package
bun run test:package
```

- `check` runs Biome, the TypeScript 7 compiler, and all unit tests.
- `test:integration` builds production bundles and runs the extension in a real VS Code Extension
  Host.
- `package` repeats the safe pre-publish gates, invokes VSCE, then checks required assets, forbidden
  files, first-party secret patterns, README links, package and source-map bundle licenses, reviewed
  native assets, path safety, file count, and size budgets.
- `test:package` imports the Pi SDK from the unpacked VSIX, verifies its installed documentation
  paths, and activates the unpacked extension in the VS Code Extension Host.

Linux CI runs Extension Host tests through Xvfb. Do not replace a failing integration test with a
source-text assertion when the behavior can be exercised through the real VS Code API.

The default integration target is the minimum supported VS Code 1.106.3, while CI also exercises
the pinned current compatibility target 1.135.0. On macOS versions where the older upstream test
host becomes unresponsive before Mocha starts, run local UI/package QA with
`PI_AGENT_TEST_VSCODE_VERSION=1.135.0`; the Ubuntu baseline job remains authoritative for the
minimum-version contract.

## Engineering rules

- Treat every Webview message, model event, tool result, Markdown fragment, path, and restored state
  value as untrusted input.
- Keep credentials in VS Code `SecretStorage`; never put them in Webview state, snapshots, logs, or
  test fixtures.
- Mutating tools and commands must remain blocked in Restricted Mode, even if a command is invoked
  programmatically instead of through visible UI.
- Keep Webview `localResourceRoots`, CSP, command URIs, and message schemas as narrow as possible.
- Bound queues, collections, payloads, file reads, and UI update rates. Dispose timers, listeners,
  sessions, and Webview-scoped subscriptions with their owner.
- Preserve keyboard access, visible focus, screen-reader names, high contrast, reduced motion, and
  narrow secondary-sidebar layouts.
- Prefer small pure helpers with behavioral tests over source-text tests for state and lifecycle
  logic.
- Avoid new runtime dependencies unless the platform or current stack cannot solve the problem.

## Manual QA

Use a disposable local workspace and the **Run Pi Agent** Extension Development Host. Check the
areas affected by the change; for cross-cutting UI or lifecycle work, cover the complete list:

1. Send a prompt and observe streaming, Stop, retry, completion, and a restored chat.
2. Attach files and folders with normal drag, the picker, `@` search, and the Explorer context menu;
   remove a chip and confirm it is no longer sent.
3. Exercise Plan, Ask, Auto Edit, and Full Access, including Restricted Mode and permission reset.
4. Verify Deny, Allow once, Allow for session, the dangerous **Run once** path, and approval expiry.
5. Change model and reasoning settings; watch live token/context/cost updates and unknown pricing.
6. Render rich Markdown, code copy, Mermaid, file/URL links, and the final `Tools N件` accordion.
7. Open multiple chats and verify tab status, titles, background completion, narrow widths, keyboard
   access, high contrast, and reduced motion.
8. When packaging changes, install the generated VSIX in a clean profile and repeat activation.

Never capture a real provider key, private source, full prompt, or session transcript in screenshots
or issue attachments.

## Dependencies and licenses

Run `bun run audit:dependencies` after dependency changes. Any accepted exception needs a clear
scope, severity, and expiry recorded in the pull request. Update `THIRD_PARTY_NOTICES.md` and the
`licenses/` directory whenever shipped license obligations change. The package verifier derives
the compiled dependency set from both production source maps, so an undeclared bundled package or
stale exact version fails the release gate even when it is only a development dependency before
bundling.

Dependabot monitors both Bun packages and pinned GitHub Actions. Keep actions pinned to full commit
SHAs; the trailing version comment is only a human-readable update hint.

## Pull request checklist

- The user-visible behavior and failure mode are described.
- New behavior has a behavioral test at the lowest useful level.
- Restricted Mode and Webview input boundaries were considered.
- Timers, listeners, sessions, and pending work have an owner and disposal path.
- `bun run check`, `bun run test:integration`, `bun run package`, and `bun run test:package` pass.
- User documentation, changelog, notices, and screenshots are updated when applicable.
