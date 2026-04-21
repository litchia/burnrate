# Claude Code Cost Tracker

Track Claude Code API spend locally inside VS Code.

The extension reads Claude Code session logs from `~/.claude/projects/`, computes cost from the recorded `usage` fields, and shows spend by project, day, and model.

No API keys. No telemetry. No network dependency.

## What It Supports

Built-in pricing is intentionally limited to:

- Claude Opus series
- Claude Sonnet series
- GPT series

If you use other providers or custom model aliases, add them through `claudeCostTracker.customPricing`.

The analyzer is based on real Claude log structure:

- It uses the final `usage` record for each assistant turn.
- It attributes project spend from the real `cwd` stored in the log.
- It distinguishes 5-minute and 1-hour cache writes when the log includes both.

## Quick Start

```bash
npm install
npm run compile
```

Then in VS Code: press `F5` to launch the Extension Development Host, and run **"Claude Cost Tracker: Show Dashboard"** from the Command Palette.

## What You See

- Total spend, tokens used, cache hit rate
- Per-project cost breakdown
- Calendar heatmap (day) and hourly heatmap (today)
- Spend by model
- Spike detection for expensive turns (priced by USD, unpriced by token volume)
- Time filters: Today / This Month / All Time

## Custom Pricing

If a model is not covered by the built-in table, the extension will mark it as unpriced and count it as `$0` until you configure it.

Open VS Code Settings and edit `claudeCostTracker.customPricing`.

Example:

```json
{
  "claudeCostTracker.customPricing": {
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
      "cache_read": 1.25
    }
  }
}
```

Notes:

- All prices are in `USD per 1M tokens`.
- `cache_write_5m`, `cache_write_1h`, and `cache_read` are optional.
- Legacy `cache_write` is still accepted and is treated as `cache_write_5m`.
- Prefix matching is supported, so a key like `gpt-4o` will match `gpt-4o-2024-11-20`.
- If your logs only contain `cache_creation_input_tokens` (legacy field) without a `cache_creation.ephemeral_*` breakdown, this project prices it as `cache_write_5m`.
- If a model price only defines `cache_write_5m` and not `cache_write_1h`, the 1-hour cache write price falls back to the 5-minute cache write price.

## Accuracy Notes

This project can get real usage data from Claude logs, but it is still an estimate layer over local logs, not an official billing export.

Known boundaries:

- Models without a configured price are shown as unpriced and counted as `$0`.
- Some metadata-only assistant turns (labeled as `<synthetic>` in certain log formats) are excluded from totals.
- Provider-specific pricing rules outside the built-in table are not guessed automatically.
- If a provider bills extra dimensions not present in the log or not yet modeled here, those are not included.

For Claude logs specifically, the parser avoids the common overcounting bug where one assistant turn is split across multiple JSONL events but repeats the same `message.id`.

## Log Retention

Claude Code prunes session logs after 30 days by default. To retain full history, edit `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 100000 }
```

Without longer retention, "All Time" only means "all logs still on disk".

## Scope

This extension is deliberately narrow:

- Built-in pricing stays small and predictable.
- Non-default providers are expected to be configured manually.
- There is no remote pricing fetch, community pricing feed, or external sync.

## License

MIT
