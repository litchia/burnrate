# Claude Code Cost Tracker

Track your Claude Code API costs locally — zero config, privacy-first.

Reads JSONL session logs from `~/.claude/projects/` and aggregates spend by project, day, and model. No API keys, no network calls, no telemetry.

## Quick Start

```bash
npm install
npm run compile
```

Then in VS Code: press `F5` to launch the Extension Development Host, and run **"Claude Cost Tracker: Show Dashboard"** from the Command Palette.

## Features (MVP)

- Total spend, tokens used, cache hit rate
- Per-project cost breakdown (decoded from `cwd`)
- Daily spend trend chart
- Cost-per-model breakdown
- Spike detection (assistant turns costing > $1)
- Time filters: Today / This Month / All Time

## Tip: Keep history longer than 30 days

Claude Code prunes session logs after 30 days by default. To retain full history, edit `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 100000 }
```

## License

MIT
