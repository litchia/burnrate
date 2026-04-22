# BurnRate — Project Instructions for Claude

> Context for any agent working on this repo. Read before changing code.
> Current state of work lives in `ROADMAP.md`.

## What this is

A VS Code extension that reads local AI CLI session logs and renders a
cost / token / quota dashboard. Currently supports Claude Code; v2.0 adds
Codex CLI. Local-first, zero-config, no API keys, no telemetry.

**This is a public Marketplace plugin.** Every design decision must be made
from the perspective of a stranger installing it cold — not from the
perspective of the maintainer's own usage patterns. See "Mindset" below.

## Mindset (non-negotiable)

### 1. Public-plugin perspective, not maintainer perspective
When evaluating UX trade-offs ("should we paginate?", "what happens with
24 months of data?", "what's the empty state?"), assume the user is:
- Heavy user with 24+ months of history
- Sparse user with multi-month gaps
- Brand-new user with 1 day of data
- Non-English user (Chinese / Japanese / Korean / etc.)
- User of non-Anthropic / non-OpenAI models routed through Claude Code
- On Windows, macOS, or Linux
- On slow disk / large `~/.claude` (10k+ JSONL files)

If the maintainer's own setup is the *only* one where the feature works
well, the feature is broken. Test against the worst plausible user, not
the best.

### 2. Cross-platform from day one
Every new path-handling, shell-touching, or filesystem-watching change
must work on Windows. See "Cross-platform rules" below. If you can't
verify on Windows, write defensively (use `path.join`, never split on
`/`, etc.) and add a CI check.

### 3. Empirically verify data shape before designing
We've been bitten before by assuming JSONL structure. Before designing
any feature touching new event types:
1. Inspect real fixture files from `~/.claude/projects/` or
   `~/.codex/sessions/` with a one-liner.
2. Check edge cases: missing fields, unknown values, duplicates across
   files, dedup keys.
3. Document findings in `ROADMAP.md` ("Codex data shape (verified
   against …)") so the next agent doesn't re-derive them.

### 4. Adversarial review loop with Codex
Established workflow: Claude designs → Codex implements → Claude does
adversarial code review → Codex fixes → Claude re-reviews. Use this for
any non-trivial change. Past reviews caught:
- Tokens=0 counted-then-skipped ordering (would mis-report message
  totals)
- Empty dedup key handling (would collapse all unkeyed events into one)
- Spike threshold not applying to unpriced models (would hide spikes
  for GLM/Qwen users)
- CSP nonce single-`replace` bug (broke webview entirely)
- Theme-aware heatmap colors via `color-mix` instead of hardcoded RGBA
- Race protection via `requestId` sequence on rapid range-switching
- Async pool concurrency safety analysis
- Cache write 5m vs 1h pricing split
- Synthetic-event silent drop → counter exposed in UI
- Light-theme white text on heatmap day labels

The pattern: **adversarial reviewer assumes nothing, demands evidence,
defaults to "broken until proven safe".**

## Cross-platform rules

### Path handling
- **Always** use `path.join` / `path.sep`, never string concat with `/`.
- **Never** `split("/")` for path components — use a helper that splits
  on both `/` and `\`. `shortPath()` in webview/main.js is the canonical
  place; if you write a second one, refactor.
- Project dir name decoders (`decodeProjectDir`) are platform-specific:
  Claude Code on Windows encodes `C:\…\proj` differently from Unix
  `-foo-bar`. Lean on the actual `cwd` field in event payloads
  (verified present on every assistant turn) and treat the dir-name
  decoding as a best-effort fallback only.
- Path equality: case-sensitive on macOS/Linux, case-insensitive on
  Windows. Use a `samePath(a, b)` helper.

### Filesystem
- All `fs` calls already work cross-platform; just don't shell out.
- JSONL reading: `crlfDelay: Infinity` mandatory (Windows uses CRLF).
- Encoding: explicitly `utf8`, never platform default.
- Don't assume case-sensitive filenames.

### Shell / scripts
- Avoid `.sh` build scripts. `package.json` scripts must be
  cross-platform (use `tsc`, not `bash`-isms).
- If a script genuinely needs platform branching, use `cross-env` /
  `npm-run-all` or write a short Node script.

### Time
- Always store local-timezone day/hour keys, computed the same way on
  server and client (Node `new Date().getFullYear()` etc., not UTC ISO
  slicing).
- Never assume the server (extension host) and the webview are in
  different timezones — they're not — but never use ISO UTC strings as
  display either.

## Architecture invariants

### Webview ↔ extension protocol
- All messages carry a `requestId` (sequence number). Client drops
  responses with `requestId < lastRequestId` to handle race conditions
  on rapid user actions.
- Inline `<script>` only, via `{{INLINE_JS}}` placeholder in HTML +
  nonce CSP. **Use `split().join()` not `String.replace()`** — replace
  only does first occurrence and treats `$` specially.
- Webview ↔ extension always via `postMessage`; never direct DOM
  injection from extension.

### Pricing
- USD per 1M tokens, not per token.
- Three-tier resolution: custom > built-in (`BUILTIN_PRICING` in
  `src/pricing.ts`). Remote pricing was deliberately removed in v1.0;
  do not re-add without strong justification.
- Match by exact key first, then longest-prefix match. So
  `gpt-4o-2024-11-20` resolves to `gpt-4o` if exact missing.
- Plan-included subscription cost (Codex free/plus/pro) is computed at
  full API price as **implied cost**; never show $0 just because the
  user is on a flat-rate plan. Plan info is display metadata only.
- Reasoning output tokens (OpenAI o-series, gpt-5.x) default to the
  model's `output` rate when `reasoning_output` not specified — that's
  OpenAI's actual billing policy.
- Cache write tokens: prefer `cache_creation.ephemeral_5m_input_tokens`
  + `ephemeral_1h_input_tokens` split; fall back to legacy
  `cache_creation_input_tokens` priced at the 5m rate.

### Dedup
- Claude Code: per-file dedup by `message.id` (msg_*) with last-write
  wins. Empirically verified (1163 unique IDs across 48 files, zero
  cross-file collisions). Falls back to `event.uuid`; rejects if both
  empty.
- Codex: no message ID. Per-file dedup by `(file, timestamp)` — within
  a session, every `token_count` event has a unique timestamp.
- Always per-file scope, never global. Global dedup hides real
  cross-session data.

### Concurrency
- `asyncPool(8, …)` for parallel file processing. Safety relies on the
  callback being **fully synchronous after await points** — no shared-
  state mutations across `await` boundaries. If you add an `await`
  inside `processFile`'s `onTurn` callback, you break this guarantee
  and need explicit locks.

## Naming & branding

- Display name: **BurnRate**. Not "Claude Code Cost Tracker" anymore.
- Tagline: "Local cost & quota dashboard for Claude Code and Codex CLI"
- Settings namespace: `burnRate.*` (was `claudeCostTracker.*`). v2.x
  reads both with deprecation toast on the legacy keys; v3.0 drops
  legacy.
- Commands: `burnRate.showDashboard`, `burnRate.refresh`,
  `burnRate.ignoreModel`.
- Marketplace publisher: `litchia`.
- Repo: <https://github.com/litchia/burnrate>.

## Decisions already made (don't re-litigate)

- **Remote pricing removed.** Custom + built-in only. Adds value <
  maintenance burden + new failure mode.
- **Synthetic turns excluded but counted.** Show count in totals so
  users can audit.
- **Spike threshold for unpriced models is token-based.** Cost-based
  threshold would hide all GLM/Qwen/etc. spikes at $0.
- **Heatmap colors via `color-mix`.** Light- and dark-theme support
  comes free. Don't hardcode RGBA.
- **Local timezone everywhere.** Day key, hour key, spike timestamp
  formatter — all use local time. UTC strings only as last-resort
  fallback when Date parsing fails.
- **Hourly heatmap "today" date hardcoded client-side.** Cross-midnight
  race window is sub-second and the cost of a server-side handshake
  isn't worth it. Documented as known non-issue.

## Workflow

- All work is gated by `ROADMAP.md`. Pick the next item, do it, update
  ROADMAP if scope changed.
- Commits: small, focused, present-tense imperative subject. Keep
  bodies brief.
- After major changes, ask the user (Claude session) for adversarial
  review before declaring done.
- Tag releases as `v<major>.<minor>.<patch>` with annotated tag.
- Don't push without user explicit go-ahead.
- Don't auto-publish to Marketplace until v2.0 ships.

## What's NOT here

- No telemetry, ever.
- No outbound network calls (besides built-in pricing constants
  shipped in code).
- No API keys.
- No background polling. Webview refresh is user-triggered or
  fired by VS Code config-change events.
- No DB, no cache files, no temp files. The extension is read-only
  against `~/.claude` and `~/.codex`.
