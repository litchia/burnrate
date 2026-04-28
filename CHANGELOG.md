# Changelog

## v2.1.0 — 2026-04-29

### Added

- **CLI distribution** as `burnrate-cli` on npm. Same analyzer, same data
  sources as the VS Code extension; subcommands `today` / `month` / `all`
  / `quota` print straight to the terminal with optional `--json` for
  machine consumption. Fits the agent-IDE workflow where users live in
  the terminal more than the Extensions tab.
- **Local dashboard server with full extension parity** — every
  interactive CLI run prints the terminal summary, then keeps a tiny
  HTTP server alive on `http://localhost:5757` (next free port if busy)
  and prints the URL at the bottom. The browser sees the same dashboard
  the VS Code extension renders: provider switcher, range pills,
  calendar + hourly heatmaps, project list with cost bars, model
  breakdown, spike turns, Codex weekly quota with projection,
  unknown-pricing banner. A bilingual EN / 中文 toggle is added to the
  toolbar; otherwise the UI is identical. Achieved by serving the
  unmodified webview HTML/JS plus a tiny browser-side bridge that
  translates `vscode.postMessage` to `fetch('/api/data')`. Browser is
  never auto-opened; Ctrl+C exits. Suppressed automatically when
  stdout isn't a TTY, when `--json` is set, or when `--no-server` is
  passed — so scripts, pipes, and agent invocations never hang.
- `--pricing <path>` flag for the CLI to load `customPricing` overrides
  from a JSON file (the VS Code settings store is not shared).
- `--no-server` flag to opt out of the local dashboard server.
- `--server` flag to force-start the dashboard server even when stdout
  is not a TTY (CI / docker / reverse-proxy setups).

### Changed

- **Editorial redesign** of the dashboard webview (used by both the VS
  Code extension and the CLI server). Replaces the generic
  blue-on-graphite VS Code chrome with a refined editorial-telemetry
  aesthetic: italic Iowan / Hoefler serif display, system mono for
  numbers, warm graphite (or cream-paper light) palette, ember-orange
  thermal accent that matches the BurnRate brand. The heatmap now uses
  a literal yellow → orange → crimson temperature gradient instead of
  the old generic-green scale. Pills, hairline rules, and ornamental
  marks (`§`, `△`) anchor the editorial voice. Zero network: type stack
  is system fonts only.

## v2.0.2 — 2026-04-28

### Changed

- Status bar item now shows today's total token volume (`🔥 1.2M`) instead
  of implied USD spend. Hover tooltip shows per-provider token breakdown
  with total implied spend as a secondary line.
- Refreshed Marketplace icon.

### Removed

- Activity bar entry and welcome view. BurnRate is now reached via the
  status bar and the Command Palette only.
- Legacy `claudeCostTracker.*` settings, command aliases, and the
  one-time deprecation toast. The plugin reads only `burnRate.*` now.

## v2.0.0 — 2026-04-24

### Added

- BurnRate rebrand and `burnRate.*` settings namespace with legacy
  `claudeCostTracker.*` migration fallback
- Dual-provider support for Claude Code and Codex CLI
- Provider switcher with `All Tools`, `Claude Code`, and `Codex` views
- Codex quota card and weekly rate-limits section
- Project-level tool-share bar in `All Tools`
- Sparse-month placeholders and year grouping in all-time overview
- Collapsible unknown-pricing banner with per-model ignore
- `burnRate.ignoredUnpricedModels` setting
- English / 简体中文 dashboard translation with `burnRate.language`
  setting (`auto` follows VS Code display language, or force `en` /
  `zh-cn`). Manifest strings via `package.nls.*.json`, runtime UI via
  `l10n/bundle.l10n.*.json`. Locale changes apply live without restart
- Inline note explaining that Claude Code does not expose subscription
  quota in local logs, so only Codex shows a Quota card
- Activity bar entry with a welcome view and one-click "Open Dashboard"
  button (monochrome theme-aware icon)
- Status bar item showing today's implied spend with a Claude / Codex
  tooltip split; click to open the dashboard
- `burnRate.showStatusBar` setting to toggle the status bar item
- `burnRate.statusBarRefreshSeconds` setting (default 300, minimum 30)
  to tune the status bar refresh cadence

### Changed

- Codex pricing now treats cached input as a subset of input instead of
  double-billing it
- Codex quota window usage now uses event-level timestamps instead of
  whole-day approximation
- Quota UI now distinguishes OpenAI snapshot values from local-log estimates
- Legacy command IDs remain registered for compatibility, but are no longer
  exposed in the Command Palette

### Fixed

- Request ordering in the webview so stale responses do not overwrite the
  active range/provider selection
- Unpriced high-token turns now appear in spike lists
- `isKnown` aggregation no longer depends on event iteration order
- Render failures now surface as explicit webview errors instead of hanging on
  `Loading…`
