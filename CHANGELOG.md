# Changelog

All notable changes to Pi Agent are documented in this file.

## [Unreleased]

### Added

- Secondary Sidebar container with a chat-focused view.
- Preact webview foundation with streaming protocol and internal chat tabs.
- Pi SDK host and session-management foundation.
- Four approval modes with workspace trust and dangerous-operation safeguards.
- Context limits, theme-aware colors, font controls, and background-tab activity indicators.
- Chat-first visual redesign with quieter message flow, compact controls, and accessible target sizes.
- Composer-integrated context D&D and attachment chips, with `@` search and picker fallbacks.
- Rich Markdown responses with headings, tables, task lists, quotes, safe inline references, and copyable language-labelled code blocks.
- Reliable selection of Plan, Ask, Auto Edit, and Full Access, including trusted-workspace safeguards and correct post-run mode switching.
- Composer-side model settings and session usage controls placed next to Send, replacing the former workspace configuration row.
- Quiet, reduced-motion-aware activity feedback with specific Japanese progress summaries and non-disruptive streaming scroll behavior.
- Customizable Pi Agent chat avatar with an original monochrome geometric default, text or emoji styling, and safely resized local raster images.
- Locally rendered, theme-aware Mermaid diagrams with six diagram families, SVG isolation, source fallback, and strict sanitization.
- Pi-avatar-aligned activity rows that show Japanese work summaries while running and collapse into an accessible Tools disclosure when complete.
- A quick-start Japanese README for non-specialists, plus separate contribution, architecture, and security guides.
- Cross-platform CI, dependency vulnerability auditing, exact-case documentation-link checks, and bounded VSIX content verification.

### Changed

- Auto Edit now runs ordinary commands without approval while continuing to require one-shot confirmation for deletion and dangerous commands.
- Full Access now runs critical and known-dangerous commands without repeated approval while preserving direct secret and outside-workspace confirmations, and uses an amber warning treatment instead of error red.
- Made chat links conservative around Japanese prose while preserving Markdown links, line references, balanced URL punctuation, and real workspace navigation.
- Refined the composer-side Model and Session Usage controls with readable spacing, responsive wrapping, viewport-safe popovers, and complete tool-path wrapping.
- Added live streaming context, token, and cost updates with subscription-aware and unknown-pricing states.
- Kept each live tool round inspectable while Pi works, then consolidated it into one collapsed `Tools N件` disclosure on the final response; expanding it restores every tool name, detail, and result without leaving empty intermediate Pi rows.
- Rebalanced composer controls around the prompt and moved vertical resizing to an accessible top-center handle.
- Split large UI and host responsibilities into tested domain helpers, enabled stricter TypeScript checks, and added source-layer boundary tests.
- Bounded chats, live history, tool state, context resolution, references, approval state, edit reviews, and package size to keep long sessions responsive.
- Made restored state, background failures, credential updates, permission resets, activation cleanup, and workspace persistence fail safely and consistently.
- Made releases reproducible across supported desktop platforms by excluding unused clipboard natives, retaining Pi's installed SDK documentation, and verifying bundled licenses and the unpacked VSIX runtime.

## [0.1.0] - 2026-08-27

- Initial preview scaffold.
