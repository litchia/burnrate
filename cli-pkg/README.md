# burnrate-cli

**Terminal cost & quota tracker for Claude Code and Codex CLI.**

Reads your local `~/.claude` and `~/.codex` log directories, prints today's
token volume, this month's spend, all-time totals, and Codex weekly quota
status — straight in the terminal.

Zero config. No API keys. No telemetry. No outbound network.

## Install

```bash
# One-off
npx burnrate-cli today

# Or globally
npm install -g burnrate-cli
burnrate today
```

## Commands

```
burnrate                 # today (default)
burnrate today           # today's tokens + implied spend + top model
burnrate month           # this month: spend, active days, top day, top projects
burnrate all             # all-time totals
burnrate quota           # Codex weekly window: used %, projection, reset time
burnrate help            # full help
```

## Local Dashboard

Each interactive run prints the terminal summary **and** keeps a local
HTTP server alive on `http://localhost:5757` (next free port if 5757 is
busy). The URL appears at the bottom of the terminal output:

```
  → Open in browser: http://localhost:5757
  (Ctrl+C to quit)
```

Click to load the **same dashboard the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=litchiak.burnrate)
renders** — provider switcher, range pills, calendar + hourly heatmaps,
project bars, model breakdown, spike turns, Codex weekly quota with
projection, unknown-pricing banner. A bilingual EN / 中文 toggle is added
to the toolbar; otherwise it's the unmodified webview, served locally.
The CLI hosts it; your browser fetches `/api/data` from `localhost`.

The browser is **never auto-opened** — you choose when to switch.
Press Ctrl+C in the terminal to stop the server.

The server is automatically suppressed when the CLI runs in a
non-interactive context, so pipes, `--json`, and agent invocations
never hang:

- `--json` → emits JSON and exits
- stdout is not a TTY (e.g. `burnrate today | jq`) → no server
- `--no-server` → opt out explicitly

## Examples

```bash
burnrate today --provider claude     # only Claude Code logs
burnrate quota --json                # machine-readable Codex quota
burnrate month --pricing pricing.json
```

## Flags

| Flag | Description |
|---|---|
| `--provider <all\|claude\|codex>` | Filter by tool (default `all`) |
| `--json` | Emit JSON instead of formatted text |
| `--no-color` | Disable ANSI colors (also honors `NO_COLOR`) |
| `--no-server` | Don't start the local dashboard server, exit after the terminal summary |
| `--pricing <path>` | JSON file with `customPricing` overrides for unpriced models |

The `--pricing` file accepts either the bare map or the same shape used by
the VS Code extension's `burnRate.customPricing` setting:

```json
{
  "customPricing": {
    "glm-4.5":     { "input": 0.6, "output": 2.2, "cache_read": 0.12 },
    "qwen-max":    { "input": 1.6, "output": 6.4 }
  }
}
```

All prices are USD per 1M tokens.

## Why the CLI

If you live in Cursor / Windsurf / Trae / Claude Code / Codex CLI / any
agent IDE — you spend more time in a terminal than in an Extensions tab.
This is the same dashboard data the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=litchiak.burnrate)
shows, in a form that fits next to your prompt.

## What It Reads

- Claude Code: `~/.claude/projects/*/<session>.jsonl`
- Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

On Windows, the same paths under `%USERPROFILE%`.

Built-in pricing covers Claude Opus / Sonnet series and OpenAI GPT-5.x /
GPT-4.1 / GPT-4o. Routed / domestic models (GLM, Qwen, Kimi, DeepSeek)
need a `--pricing` file, otherwise their tokens are shown but counted
as `$0` for the implied-cost line.

## Same Project, Different Surface

`burnrate-cli` is the npm distribution of [BurnRate](https://github.com/litchia/burnrate).
The same repo also publishes a VS Code extension on the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=litchiak.burnrate)
and [Open VSX](https://open-vsx.org/extension/litchiak/burnrate) (works on
Cursor, Windsurf, Trae, Antigravity).

## License

MIT
