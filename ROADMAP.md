# BurnRate Roadmap

Tracking work beyond v1.0.0. Framed from the perspective of a public VS Code
Marketplace plugin serving heterogeneous users (heavy users with 24+ months of
history, sparse users with gaps, new users with 1 day of data, non-English
users, users of non-Anthropic models routed through Claude Code).

Priorities:
- **P0** — fixes a broken or trust-eroding experience for a real user segment.
- **P1** — meaningful UX upgrade; ship within 1–2 versions.
- **P2** — power-user / scaling features; defer until justified by feedback.

---

## v1.1 — Long-history & first-impression polish

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
