# BurnRate

**Cost & quota dashboard for Claude Code and Codex CLI — inside VS Code.**

See your spend burn down in real time. Forecast when your Codex weekly quota
will run out. Catch token spikes — even on routed models like GLM, Qwen,
Kimi, or DeepSeek that other trackers price as `$0`.

All local. No API keys. No telemetry. No outbound network.

---

## Why BurnRate

Most usage trackers answer *"what did I spend yesterday?"* BurnRate answers
three questions the others don't:

### 1. When will I run out?
Codex has a weekly quota. BurnRate projects exhaustion from your local
7-day pace and flags when you're trending over the limit — before OpenAI's
throttle hits mid-PR.

### 2. Which turn blew up my budget?
Spike detection surfaces the top cost turns in the range. For priced
models, the threshold is USD. For **unpriced or routed models**, it falls
back to token volume — so you still see the spike even when cost is `$0`.

### 3. What's actually happening when I route through GLM / Qwen / Kimi?
If you use Claude Code with a third-party proxy (common in 中国 users' setups),
ccusage and most dashboards report `$0` forever. BurnRate shows the token
volume, lets you add pricing with two lines of config, and makes the
invisible traffic visible.

---

## Is this different from "Claude Code and Codex Assist"?

Yes — different category, not a competitor. That extension is a **session
history browser** (diffs, full-text search, resume conversations) with
usage tracking as a supporting feature. BurnRate is a **dedicated cost &
quota dashboard** — we don't browse sessions, they don't forecast quota.
Install both if you want both.

| | BurnRate | History Viewers |
|---|:---:|:---:|
| Unified Claude + Codex dashboard | ✅ | ✅ |
| Session browser / diff / resume | ❌ | ✅ |
| Codex quota exhaustion forecasting | **✅** | ❌ |
| Priced + unpriced spike detection | **✅** | ❌ |
| Routed-model support (GLM / Qwen / Kimi / DeepSeek) | **✅** | ❌ |
| Custom pricing override | **✅** | ❌ |
| Hourly + calendar heatmap | **✅** | partial |
| 简体中文 UI | **✅** | ❌ |

---

## What It Reads

- Claude Code: `~/.claude/projects/*/<session>.jsonl`
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

On Windows:

- Claude Code: `%USERPROFILE%\.claude\projects`
- Codex CLI: `%USERPROFILE%\.codex\sessions`

Built-in pricing covers Claude Opus / Sonnet series and OpenAI GPT-5.x /
GPT-4.1 / GPT-4o. Everything else — including routed domestic models — is
one `burnRate.customPricing` entry away.

---

## Quick Start

Install from the VS Code Marketplace, then run **`BurnRate: Show Dashboard`**
from the Command Palette.

Building from source:

```bash
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host.

---

## Entry Points

- **Status Bar.** A compact `🔥 1.2M` item in the bottom-right shows today's
  total token volume at a glance. Hover for a Claude / Codex token split
  plus today's implied spend; click to open the dashboard. Hide it entirely
  with `burnRate.showStatusBar: false`. Adjust refresh cadence with
  `burnRate.statusBarRefreshSeconds` (default 300, minimum 30).
- **Command Palette.** `BurnRate: Show Dashboard` and `BurnRate: Refresh
  Data` are the canonical entry points.

---

## Dashboard Features

**Spend & usage**
- Provider switcher: `All Tools` / `Claude Code` / `Codex`
- Total spend, implied API spend, tokens, cache-reuse ratio
- Project rows with spend bars and per-tool share in `All Tools`
- Model breakdown with priced / unpriced labeling

**Heatmaps**
- Calendar heatmap for month and all-time
- Hourly heatmap for today
- Theme-aware colors (works in dark + light)

**Forecasting & alerts**
- **Codex weekly quota card** with exhaustion projection from 7-day local pace
- **Spike turn list** (priced threshold + unpriced token-based fallback)
- Collapsible unknown-pricing banner with per-model ignore
- All-time overview with sparse-month placeholders and year grouping

**Languages**
- English and 简体中文 (`burnRate.language` setting, `auto` by default)

---

## Routed / Unpriced Models

If you route Claude Code through a proxy to models like **GLM-4.5, Qwen-Max,
Kimi-K2, or DeepSeek-V3**, they show up in the dashboard the moment you use
them. Token volume is always tracked. To get dollar estimates, add two lines:

```json
{
  "burnRate.customPricing": {
    "glm-4.5":     { "input": 0.00, "output": 0.00, "cache_read": 0.00 },
    "qwen-max":    { "input": 0.00, "output": 0.00 },
    "kimi-k2":     { "input": 0.00, "output": 0.00 },
    "deepseek-v3": { "input": 0.00, "output": 0.00 }
  }
}
```

All prices are `USD per 1M tokens`. **Fill in the numbers from each
provider's official pricing page** — rates change often and BurnRate
deliberately ships no live price feed. Prefix matching is supported
(`gpt-4o` matches dated variants).

Don't want to price them? Add them to `burnRate.ignoredUnpricedModels` and
they'll stop triggering the warning banner. Token-based spike detection
still works.

---

## Settings

### `burnRate.customPricing`

Add pricing for models not covered by the built-in table:

```json
{
  "burnRate.customPricing": {
    "my-gpt-alias": {
      "input": 2.5,
      "output": 10,
      "cache_read": 1.25,
      "reasoning_output": 10
    }
  }
}
```

Notes:

- All prices are `USD per 1M tokens`.
- `reasoning_output` defaults to `output`.
- Legacy `cache_write` is accepted as `cache_write_5m`.
- If a log only contains legacy `cache_creation_input_tokens`, BurnRate
  prices it at the 5-minute cache-write rate.
- If `cache_write_1h` is omitted, it falls back to the 5-minute rate.
- Prefix matching is supported.

### `burnRate.spikeThresholdUsd`

Turns above this per-turn USD threshold are listed as priced spikes.
Unpriced models still surface in spikes by token volume.

### `burnRate.ignoredUnpricedModels`

Models in this list are hidden from the warning banner. They still count as
unpriced (`$0`) unless you also add pricing for them.

### `burnRate.language`

`auto` (default) follows VS Code's display language. Force English with
`en` or 简体中文 with `zh-cn`. Changes apply live — no restart.

---

## Settings Migration

Legacy `claudeCostTracker.*` settings are still read for one migration window:

- `claudeCostTracker.customPricing`
- `claudeCostTracker.spikeThresholdUsd`
- `claudeCostTracker.ignoredUnpricedModels`

Move them to `burnRate.*` before v3.0.

---

## Accuracy Notes

BurnRate is a **local-log estimate layer**, not an official billing export.

- Unpriced models are counted as `$0` until configured.
- `<synthetic>` Claude turns are excluded from spend totals (count shown in UI).
- Codex spend is shown as **implied API cost** even on flat-rate plans —
  so you can compare plan value vs raw API pricing honestly.
- Codex quota and projection mix two sources:
  - `usedPercent` comes from OpenAI rate-limit snapshots in the local Codex log
  - `window usage`, `7-day avg`, and `projection` are derived from local log events
- Projection can undercount if old sessions were pruned or usage happened
  on another machine.
- Claude Code does not expose subscription quota in its local logs —
  that's why only Codex gets a Quota card.

Dedup details: Claude logs are deduped per-file by `message.id`. Codex
logs are deduped within a file by `(file, timestamp)`, and `token_count`
events are associated with the preceding `turn_context` to recover the
model name.

---

## Log Retention

Claude Code prunes session logs after 30 days by default. To keep longer
history, edit `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 100000 }
```

Without longer retention, `All Time` only means "all logs still on disk".

---

## Cross-Platform

BurnRate runs on **macOS, Linux, and Windows**. The repo CI builds on all three.

On Windows:

- Claude project-dir decoding is intentionally conservative; BurnRate
  prefers the recorded `cwd` field over guessing from encoded folder names.
- Path rendering keeps the drive letter when truncating long paths.
- Empty states and dashboard copy refer to the platform's default local log
  directories rather than Unix-only example paths.

---

## Scope

BurnRate is intentionally narrow:

- Cost & quota dashboard, not a session browser
- Small built-in pricing table + user overrides for everything else
- No remote pricing feed
- No telemetry, no outbound calls, no temp files, no DB

If you need diff viewing, session resume, or full-text search across
conversation history — pair BurnRate with a dedicated history viewer.

---

## License

MIT
