# BurnRate Roadmap

Tracking work beyond v1.0.0. Framed from the perspective of a public VS Code
Marketplace plugin serving heterogeneous users (heavy users with 24+ months of
history, sparse users with gaps, new users with 1 day of data, non-English
users, users of non-Anthropic models routed through Claude Code, mixed
Claude+Codex users on macOS / Linux / Windows).

Priorities:
- **P0** — fixes a broken or trust-eroding experience for a real user segment.
- **P1** — meaningful UX upgrade; ship within 1–2 versions.
- **P2** — power-user / scaling features; defer until justified by feedback.

---

## v2.0 — Codex CLI support, rebrand, cross-platform

**Theme.** Become a multi-provider AI CLI cost & quota dashboard. Lock in the
"BurnRate" brand. Run cleanly on Windows.

### Codex data shape (verified against `~/.codex/sessions/`)

- Path: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
- Per-turn usage: `{type:"event_msg", payload:{type:"token_count",
  info:{last_token_usage:{input_tokens, cached_input_tokens,
  output_tokens, reasoning_output_tokens, total_tokens}}}}`
- **Trap 1:** `total_token_usage` is the running session total — must use
  `last_token_usage` only when summing.
- **Trap 2:** No message-id dedup key. Use `(file, timestamp)` tuple as
  per-file dedup scope.
- Model is in a separate `turn_context` event, not on the token event —
  must associate by `turn_id`.
- `cwd` is in `session_meta` (per session) and `turn_context` (per turn).
- `rate_limits.primary` carries plan-quota state on every token_count event.

### P0 — Provider abstraction & Codex MVP

#### v2.0-1. Rebrand to BurnRate
- `package.json` `name: "burnrate"`, `displayName: "BurnRate"`,
  `description: "Local cost & quota dashboard for Claude Code and Codex CLI"`
- Commands renamed: `burnRate.showDashboard`, `burnRate.refresh`,
  `burnRate.ignoreModel` (new)
- Webview `<h1>BurnRate</h1>`; subtitle "Claude Code · Codex CLI"
- README rewritten around two providers; new screenshots
- Settings namespace migration: `claudeCostTracker.*` → `burnRate.*`. Read
  both for one minor version, log a one-time deprecation toast pointing at
  settings.json. Drop legacy in v3.0.

#### v2.0-2. ProviderAdapter abstraction
```ts
interface ProviderAdapter {
  id: "claude-code" | "codex";
  defaultRoot(): string;
  listSessionFiles(root: string): Promise<FileTask[]>;
  processFile(file: FileTask, onTurn: (turn: NormalizedTurn) => void): Promise<void>;
}
```
- `claudeCodeAdapter` wraps current logic.
- `codexAdapter` walks `YYYY/MM/DD/` tree, parses `session_meta` →
  per-turn `token_count` with `turn_context` model lookup.
- `analyze()` runs both adapters in parallel through `asyncPool`, tags
  every `NormalizedTurn` with `provider`.
- All result shapes (`ProjectStats`, `Spike`, `ModelStat`) gain a
  `provider` field. `byProject` keys stay `cwd`-based so cross-tool work
  in the same repo aggregates.

#### v2.0-3. Codex pricing
- All Codex turns priced via `BUILTIN_PRICING` OpenAI entries (already
  present from v1). Plan flag is **display metadata only** — never
  zeroes-out the cost.
- New `reasoning_output` token category. Pricing schema gains
  `reasoning_output: number` field, defaulting to the model's `output`
  rate when not specified (per OpenAI policy).
- Update `sanitizePricing` and the `customPricing` JSON schema docs.

#### v2.0-4. Provider segmented control + per-provider views
- Top toolbar gains `[All Tools] [Claude Code] [Codex]` segment.
  Persisted via `vscode.setState`.
- **All Tools view:** combined totals card + new "By Tool" card showing
  spend split, then unified Heatmap / Projects / Models / Spikes with
  inline provider tags (📘 / 🟢).
- **Claude Code view:** identical to v1.
- **Codex view:** replaces "Top Project" card with **Quota card** (see
  v2.0-5), shows "implied API cost" with a `Plan: <plan>` badge in the
  cost card.
- Hover detail card on heatmap: adds "By Tool" sub-section in All Tools
  view.

#### v2.0-5. Codex quota + projection card
- Renders latest `rate_limits.primary` from any token_count event in the
  current week.
- Progress bar: green <50%, yellow 50–85%, red >85%.
- Shows `resets_at` formatted as "Resets in 2d 4h" + absolute local
  timestamp.
- **Projection:** average `last_token_usage.total_tokens` per active day
  over the last 7 days, linear-extrapolate to predict when
  `used_percent` will hit 100%. Print "At current rate you'll hit limit
  ~Sat Apr 26" only when projection lands inside the current reset
  window. Hide when sample size < 3 active days (avoid garbage
  predictions).

#### v2.0-6. Rate Limits section (Codex only)
- Weekly window summary
- Last 7 days avg tokens/day
- Projected exhaust timestamp
- Recent `usage_limit_exceeded` events (scan
  `event_msg.type == "error" && codex_error_info == "usage_limit_exceeded"`),
  show count + most recent timestamp.

#### v2.0-7. Project rows show tool-share bar
- After the existing cost bar, render a small horizontal stacked bar:
  `📘 80% / 🟢 20%`. Computed from per-provider cost share within that
  project.

#### v2.0-8. Cross-platform fixes
- **`shortPath`**: split on both `/` and `\\`. Detect Windows paths
  (`/^[A-Za-z]:[\\\/]/`) and preserve drive letter when truncating.
- **`decodeProjectDir`**: only used as fallback when `cwd` is missing;
  on Windows, attempt no decoding (return raw dir name) and lean on
  `cwd` field. Document this limitation in README.
- **`.gitignore`**: add `.DS_Store`, `Thumbs.db`, `out/`. `git rm
  --cached` the existing `.DS_Store`.
- **`.vscodeignore`** (new): exclude `src/`, tests, `out/*.map`,
  `.git/`, `node_modules/`, `ROADMAP.md`, `.DS_Store`, etc. from
  packaged `.vsix`.
- **CI smoke test on Windows**: GitHub Actions matrix
  `os: [ubuntu, macos, windows]` running `npm run compile` + a small
  unit test that exercises `processFile` against fixture JSONL.
  Catches path / line-ending / encoding regressions early.
- **Path comparisons**: any cwd-vs-cwd equality check (none today, but
  in the new tool-share aggregation) must be case-insensitive on
  Windows. Use a `samePath()` helper with `process.platform === "win32"`
  branch.
- **Local timezone day key on Windows**: `new Date().getHours()` works
  identically; no change. Verify with CI fixture.

### P1 — UX upgrades that come along for the ride

#### v2.0-9. Sparse-month placeholders + year separators
(Originally v1.1 #1 + #2.) With multi-provider data, sparse months are
even more likely. Roll into v2.0.

#### v2.0-10. Smarter empty-state messaging
(Originally v1.1 #3.) Adapt for multi-provider:
- Both roots missing → "No Claude Code or Codex logs found. Use either
  CLI then refresh."
- Only one root present → mention which provider is active.
- Provider tab selected but that provider has no data → "Codex has no
  data — switch to Claude Code or All Tools."

#### v2.0-11. Dismissible unknown-pricing banner
(Originally v1.1 #4.) Now also accounts for unknown OpenAI variants
that route through Codex.

### P2 — Defer to v2.1+

- Default-collapse to recent 12 months (v1.1 #5)
- Auto-scroll selected mini-month (v1.1 #6)
- Sensible default range for new users (v1.1 #7)
- Year-heatmap view (v1.1 #8)
- CSV / JSON export (v1.1 #9)
- Session drill-down for spikes (v1.1 #10)

### v2.0 deliverable cut-list (in order)

1. Cross-platform fixes + .vscodeignore + Windows CI (foundation)
2. Rebrand to BurnRate + settings namespace migration
3. ProviderAdapter abstraction (refactor existing Claude logic)
4. Codex adapter + reasoning_output pricing
5. Provider segmented control + 3 views
6. Quota card + projection
7. Rate Limits section + limit-hit scan
8. Tool-share bar in Projects
9. Sparse months + year separators + empty-state polish
10. Dismissible unknown-pricing banner
11. Update README, screenshots, CHANGELOG; tag v2.0.0

---

## v1.1 — Long-history & first-impression polish

> **Status:** items folded into v2.0 where applicable; remaining items
> deferred to v2.1+. This section preserved for reference.

### P0 — Trust-breaking gaps

#### 1. Sparse-month placeholders in All Time overview
**Problem.** `buildAvailableMonths` returns only months that have data. If a
user took a 3-month break, those months silently disappear from the grid —
making it look like data is missing or the plugin is broken.

**Fix.** Compute `[minMonth, maxMonth]` from `byDay`/`byDayTokens`, fill every
month in between, render empty months as disabled placeholder cards (greyed,
non-clickable, label only).

**Files.** `src/webview/main.js` (`buildAvailableMonths`,
`renderAllTimeOverview`, `renderMiniMonthCard`), `src/webview/index.html`
(`.mini-month.disabled` style).

#### 2. Year separators when >12 months
**Problem.** 22 months in a single flat grid with no year markers — finding
"last September" requires counting cards.

**Fix.** When `months.length > 12`, group by year. Render each year block with
an `<h3 class="year-divider">2025</h3>` heading above its mini-month cards.

**Files.** `src/webview/main.js` (`renderAllTimeOverview`),
`src/webview/index.html` (`.year-divider` style).

#### 3. Smarter empty-state messaging
**Problem.** `No usage data in this range. Try "All Time".` is shown
identically when:
- A brand-new user opens the panel on the 1st of the month (empty This Month,
  empty All Time, empty everything).
- A returning user picks a date range with no activity.

The new user thinks the plugin is broken.

**Fix.** Distinguish three states server-side or in the renderer:
- `rootExists === false` → existing message.
- `rootExists && totals.messages === 0 && range !== "all"` → "No data in this
  range yet. View All Time to see your full history."
- `rootExists && totals.messages === 0 && range === "all"` → "No assistant
  turns recorded yet. Use Claude Code, then click Refresh."

**Files.** `src/webview/main.js` (`render`).

#### 4. Dismissible / collapsible unknown-pricing banner
**Problem.** Users routing GLM, Qwen, DeepSeek, Kimi, etc. through Claude Code
will permanently see a yellow warning banner listing 5+ models. It becomes
visual noise and trains users to ignore real warnings.

**Fix.**
- Collapse to one line by default: `⚠ 5 models unpriced — click to expand`.
- Add a per-model "ignore" action that writes to a new
  `claudeCostTracker.ignoredUnpricedModels` setting.
- Once all unknown models are either priced or ignored, banner disappears.

**Files.** `src/webview/main.js` (`renderPricingBanner`), `src/extension.ts`
(filter unknown list against ignored set, register
`claudeCostTracker.ignoreModel` command), `package.json`
(`contributes.configuration`).

### P1 — Long-history UX

#### 5. Default-collapse to recent 12 months
When `months.length > 18`, render only the most recent 12 expanded; show a
`Show earlier months (10)` button that expands the rest. Persists per session
via `vscode.setState`.

**Files.** `src/webview/main.js`.

#### 6. Auto-scroll selected mini-month into view
After `state.selectedMonth` changes, call
`element.scrollIntoView({ block: "nearest", behavior: "smooth" })` on the
matching `.mini-month`.

**Files.** `src/webview/main.js` (`renderAllTimeOverview` post-render hook).

#### 7. Sensible default range for new users
Currently defaults to `month`. If `byDay` is empty for the current month but
non-empty in earlier months → silently default to `all`.

**Files.** `src/extension.ts` (initial `currentRange` decision after first
analyze) or `src/webview/main.js` (auto-switch range pill on first render).

### P2 — Scaling

#### 8. Year-heatmap view
When `months.length >= 24`, offer a third heatmap mode: 12-column × N-row grid
where each cell is one month, color-coded by total spend or token volume.
GitHub-contributions style at the year scale.

**Files.** `src/webview/main.js`, `src/webview/index.html`.

#### 9. CSV / JSON export
"Export" button on the toolbar emits `byDay` / `byProject` / `spikes` as a
download via `vscode.window.showSaveDialog`.

**Files.** `src/extension.ts` (new command), `src/webview/main.js` (button +
postMessage), `package.json` (command registration).

#### 10. Session drill-down for spikes
Click a spike row → opens a side panel showing all turns in that session,
ordered by cost. Helps users diagnose "why did this one session cost $8".

Requires analyzer to retain per-session turn detail behind a flag (memory
cost — gate to range=today / single-session views).

---

## v1.2 — Internationalization & non-Anthropic users

#### 11. README in 简体中文
A large fraction of users routing alternative models through Claude Code are in
China (GLM, Qwen, DeepSeek, Kimi). At minimum ship `README.zh-CN.md` linked
from the top of the English README.

#### 12. UI string externalization
Pull all hard-coded English strings in `main.js` into a single `STRINGS` object.
Detect `vscode.env.language` in `extension.ts`, post `locale` with each `data`
message, switch `STRINGS` table accordingly. Start with `en` + `zh-CN`.

**Files.** `src/webview/main.js`, `src/extension.ts`.

#### 13. Bundled pricing for popular non-Anthropic gateways
Add built-in entries for the most common Claude-Code-compatible providers:
- GLM-4.5 / GLM-4.6 (Zhipu)
- Qwen3-Max / Qwen3-Coder (Alibaba)
- DeepSeek-V3.x / R1
- Kimi-K2 (Moonshot)

Source prices from official pages, document `verified` date in comments.
Reduces the unknown-pricing banner for the largest non-Anthropic user
segment without requiring custom config.

**Files.** `src/pricing.ts` (`BUILTIN_PRICING`), README pricing table.

---

## v1.3+ — Engineering hygiene (carry-over from review rounds)

#### 14. Corrupted-line counter
`processFile` swallows `JSON.parse` failures silently. Surface a
`corruptedLines` counter on `totals` and show in the generated-at footer
when > 0. Helps users diagnose log corruption without us shipping a debug
flag.

#### 15. Defer `scannedFiles` count to post-pool
Currently set to `tasks.length` before processing — files deleted mid-scan
still count. Move to a counter incremented inside `processFile` on
successful read.

#### 16. Spike timestamp local fallback
`formatSpikeTimestamp` falls back to UTC string slice when `Date` parsing
fails — inconsistent with other local-time formatting. Try harder before
falling back, or omit the timestamp.

#### 17. Unit tests
Add `vitest` + tests for:
- `pricing.priceFor` across cache_creation shapes (5m+1h split, legacy
  fallback, unknown model).
- `analyzer.normalizeAssistantTurn` edge cases (missing usage, missing
  message.id, synthetic model).
- `buildAvailableMonths` with sparse data.

#### 18. `.vscodeignore` and Marketplace publishing pipeline
Pre-publish: `.vscodeignore` excludes `src/`, tests, fixtures from the
shipped `.vsix`. CI workflow runs `vsce package` on tag push.

---

## Known non-issues (won't fix without strong signal)

- **`renderHourlyHeatmap` cross-midnight race.** Race window is sub-second at
  local midnight. Cost of fixing (server-side `dayKey` handshake) is high.
  Leave alone.
- **`stats!` non-null cleanup.** Already cleaned in v1.0.0.
- **`mini-month` ARIA `role="radio"` upgrade.** `role="button"` works in all
  major screen readers. Upgrade only if a11y audit specifically flags it.
