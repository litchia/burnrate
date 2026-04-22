# BurnRate

Local cost & quota dashboard for Claude Code and Codex CLI, inside VS Code.

BurnRate reads your local AI CLI session logs, computes spend from the
recorded `usage` fields, and shows cost / tokens / quota by project, day,
hour, and model. No API keys. No telemetry. No outbound network.

> v1.x ships Claude Code support. v2.0 (in progress) adds Codex CLI
> adapter, weekly quota tracking, and a 3-tab provider switcher. See
> `ROADMAP.md`.

## What It Reads

- **Claude Code:** `~/.claude/projects/*/<session>.jsonl`
- **Codex CLI:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` *(v2.0)*

Built-in pricing covers:

- Claude Opus / Sonnet series
- OpenAI GPT-5.x / GPT-4.1 / GPT-4o series

For other providers (GLM, Qwen, DeepSeek, Kimi, custom aliases…) configure
prices via `burnRate.customPricing`.

## Quick Start

```bash
npm install
npm run compile
```

In VS Code, press `F5` to launch the Extension Development Host, then run
**"BurnRate: Show Dashboard"** from the Command Palette.

## What You See

- Total spend, tokens used, cache reuse rate
- Per-project breakdown with cost bars
- Calendar heatmap (day) and hourly heatmap (today)
- Spend by model with priced / unpriced flagging
- Spike detection (priced models by USD threshold; unpriced by token
  volume — so GLM/Qwen spikes still surface)
- Time filters: Today / This Month / All Time
- Multi-month overview when in All Time
- *(v2.0)* Codex weekly quota with projected exhaustion timestamp

## Custom Pricing

If a model is not covered by the built-in table, BurnRate marks it as
unpriced and counts cost as `$0` until you configure it.

Open VS Code Settings and edit `burnRate.customPricing`. Example:

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
- Optional fields: `cache_write_5m`, `cache_write_1h`, `cache_read`,
  `reasoning_output`.
- Legacy `cache_write` is accepted as an alias for `cache_write_5m`.
- `reasoning_output` defaults to the model's `output` rate (matches
  OpenAI's policy for o-series and gpt-5.x reasoning models).
- Prefix matching: `gpt-4o` matches `gpt-4o-2024-11-20`.
- If a log only has the legacy `cache_creation_input_tokens` field
  (no `ephemeral_5m` / `ephemeral_1h` split), it's priced at the 5m rate.
- If `cache_write_1h` is omitted, the 1-hour rate falls back to the 5-minute
  rate.

## Settings Migration (v1.x → v2.0)

If you previously configured `claudeCostTracker.customPricing` or
`claudeCostTracker.spikeThresholdUsd`, BurnRate still reads those keys and
prompts you once to migrate. Move them to `burnRate.*` when convenient;
the legacy keys are slated for removal in v3.0.

## Accuracy Notes

BurnRate computes cost from real usage data in your local logs, but this
is still an estimate layer over local logs — not an official billing
export.

Known boundaries:

- Models without a configured price are unpriced and counted as `$0`
  (a banner highlights them).
- `<synthetic>` assistant turns are excluded but counted separately.
- Provider-specific billing rules outside the built-in table aren't
  guessed automatically.
- Codex subscription plans (Free / Plus / Pro) are billed flat-rate by
  OpenAI; BurnRate shows the **implied API cost** (what the same usage
  would cost via the API) and tags it with a `Plan: …` badge so you
  can judge subscription value.

For Claude logs, the parser dedupes per-file by `message.id` to avoid the
common overcounting bug where one assistant turn is split across multiple
JSONL events.

## Log Retention

Claude Code prunes session logs after 30 days by default. To keep full
history, edit `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 100000 }
```

Without longer retention, "All Time" only means "all logs still on disk".

## Cross-Platform

BurnRate runs on macOS, Linux, and Windows. CI tests build on all three
on every push. If you hit a platform-specific bug, please open an issue
with your OS, VS Code version, and a snippet of the relevant log path
structure.

## Scope

BurnRate is deliberately narrow:

- Built-in pricing stays small and predictable.
- Non-default providers are configured manually.
- No remote pricing fetch, no community feed, no external sync.
- No telemetry. The extension is read-only against `~/.claude` and
  `~/.codex`.

## License

MIT
