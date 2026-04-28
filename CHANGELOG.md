# Changelog

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
