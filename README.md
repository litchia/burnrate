# BurnRate

Local cost and quota dashboard for Claude Code and Codex CLI inside VS Code.

BurnRate reads local session logs, estimates spend from recorded token usage,
and shows usage by provider, project, model, day, and hour. No API keys. No
telemetry. No outbound network.

## What It Reads

- Claude Code: `~/.claude/projects/*/<session>.jsonl`
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

On Windows, those default roots are typically:

- Claude Code: `%USERPROFILE%\\.claude\\projects`
- Codex CLI: `%USERPROFILE%\\.codex\\sessions`

Built-in pricing covers:

- Claude Opus and Sonnet series
- OpenAI GPT-5.x, GPT-4.1, and GPT-4o series

Other providers or aliases can be added with `burnRate.customPricing`.

## Quick Start

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host, then run
`BurnRate: Show Dashboard`.

## Dashboard Features

- Provider switcher: `All Tools` / `Claude Code` / `Codex`
- Spend, tokens, cache reuse, and spike detection
- Project rows with spend bars and per-tool share in `All Tools`
- Calendar heatmap for month/all-time and hourly heatmap for today
- Model breakdown with priced / unpriced labeling
- Codex quota card and weekly rate-limits section
- All-time overview with sparse-month placeholders and year grouping
- Collapsible unknown-pricing banner with per-model ignore

## Settings

### `burnRate.customPricing`

Add pricing for models not covered by the built-in table:

```json
{
  "burnRate.customPricing": {
    "glm-5": {
      "input": 0.28,
      "output": 1.12,
      "cache_write_5m": 0.28,
      "cache_write_1h": 0.28,
      "cache_read": 0.028
    },
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
- Legacy `cache_write` is still accepted as `cache_write_5m`.
- If a log only contains legacy `cache_creation_input_tokens`, BurnRate prices
  it at the 5-minute cache-write rate.
- If `cache_write_1h` is omitted, it falls back to the 5-minute rate.
- Prefix matching is supported, so `gpt-4o` matches dated variants.

### `burnRate.spikeThresholdUsd`

Turns above this per-turn USD threshold are listed as priced spikes.
Unpriced models still surface in spikes by token volume.

### `burnRate.ignoredUnpricedModels`

Models in this list are hidden from the warning banner. They still count as
unpriced (`$0`) unless you also add pricing for them.

## Settings Migration

Legacy `claudeCostTracker.*` settings are still read for one migration window:

- `claudeCostTracker.customPricing`
- `claudeCostTracker.spikeThresholdUsd`
- `claudeCostTracker.ignoredUnpricedModels`

Move them to `burnRate.*` before v3.0.

## Accuracy Notes

BurnRate is a local-log estimate layer, not an official billing export.

Important boundaries:

- Unpriced models are counted as `$0` until configured.
- `<synthetic>` Claude turns are excluded from spend totals.
- Codex spend is shown as implied API cost even if your Codex plan is flat-rate.
- Codex quota and projection mix two sources:
  - `usedPercent` comes from OpenAI rate-limit snapshots in the local Codex log
  - `window usage`, `7-day avg`, and `projection` are derived from local log events
- Projection can undercount if old sessions were pruned or usage happened on
  another machine.

For Claude logs, BurnRate dedupes per-file by `message.id`. For Codex logs, it
dedupes within a file by `(file, timestamp)` and associates `token_count`
events with `turn_context` to recover the model name.

## Log Retention

Claude Code prunes session logs after 30 days by default. To keep longer
history, edit `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 100000 }
```

Without longer retention, `All Time` only means "all logs still on disk".

## Cross-Platform

BurnRate runs on macOS, Linux, and Windows. The repo CI builds on all three.

On Windows:

- Claude project-dir decoding is intentionally conservative; BurnRate prefers
  the recorded `cwd` field over guessing from encoded folder names.
- Path rendering keeps the drive letter when truncating long paths.
- Empty states and dashboard copy refer to the platform's default local log
  directories rather than Unix-only example paths.

## Scope

BurnRate is intentionally narrow:

- Small built-in pricing table
- Manual overrides for non-default providers
- No remote pricing feed
- No telemetry or external sync

## License

MIT
