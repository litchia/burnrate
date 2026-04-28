#!/usr/bin/env node
// BurnRate CLI entry point.
//
// Distributed via npm as `burnrate-cli`; the installed binary is named
// `burnrate`. Same analyzer, same data sources as the VS Code extension —
// just a different output layer.

import { CliArgs } from "./format";
import { printError, runAll, runMonth, runQuota, runToday } from "./commands";

const VERSION: string = require("../../package.json").version;

const HELP = `burnrate ${VERSION}

Usage: burnrate [command] [options]

Commands:
  today          Today's tokens and implied spend (default)
  month          This month overview
  all            All-time totals
  quota          Codex weekly quota status and projection
  help, -h       Show this help
  version, -v    Show version

Options:
  --provider <all|claude|codex>  Filter by provider (default: all)
  --json                          Emit JSON instead of formatted text and exit
  --no-color                      Disable ANSI colors
  --no-server                     Don't start the local dashboard server
  --server                        Force-start the dashboard server even
                                  when stdout is not a TTY (CI / docker)
  --pricing <path>                JSON file with customPricing overrides

After the terminal summary the CLI keeps a local dashboard server running
on http://localhost:5757 (next free port if busy) and prints the URL.
Click it in any browser, or press Ctrl+C to quit. The browser is not
auto-opened. Suppressed automatically when --json is set or stdout is
not a TTY (so pipes and scripts still exit immediately).

Examples:
  burnrate
  burnrate today --provider codex
  burnrate quota
  burnrate month --json
  burnrate today --no-server
`;

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  let command = "today";
  const validCommands = new Set(["today", "month", "all", "quota", "help", "version"]);

  if (args[0] && !args[0].startsWith("-")) {
    if (!validCommands.has(args[0])) {
      throw new Error(`unknown command: ${args[0]}`);
    }
    command = args.shift()!;
  }

  let provider: CliArgs["provider"] = "all";
  let json = false;
  let noColor = false;
  let noServer = false;
  let forceServer = false;
  let pricing: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-h" || a === "--help") {
      command = "help";
      break;
    }
    if (a === "-v" || a === "--version") {
      command = "version";
      break;
    }
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--no-color") {
      noColor = true;
      continue;
    }
    if (a === "--no-server") {
      noServer = true;
      continue;
    }
    if (a === "--server") {
      forceServer = true;
      continue;
    }
    if (a === "--provider") {
      const v = args[++i];
      if (v === "claude" || v === "claude-code") provider = "claude-code";
      else if (v === "codex") provider = "codex";
      else if (v === "all") provider = "all";
      else throw new Error(`invalid --provider: ${v ?? "(missing)"}`);
      continue;
    }
    if (a === "--pricing") {
      const v = args[++i];
      if (!v) throw new Error("--pricing requires a path argument");
      pricing = v;
      continue;
    }
    throw new Error(`unknown argument: ${a}`);
  }

  return { command, provider, json, noColor, noServer, forceServer, pricing };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (e: any) {
    printError(e.message || String(e));
    process.stderr.write("\n" + HELP);
    process.exit(2);
  }

  switch (args.command) {
    case "help":
      process.stdout.write(HELP);
      return;
    case "version":
      process.stdout.write(VERSION + "\n");
      return;
    case "today":
      return await runToday(args);
    case "month":
      return await runMonth(args);
    case "all":
      return await runAll(args);
    case "quota":
      return await runQuota(args);
  }
}

main().catch((err: any) => {
  printError(err?.message || String(err));
  process.exit(1);
});
