// Terminal output helpers for the BurnRate CLI.
//
// Zero-dependency ANSI rendering. Colors are auto-disabled when stdout is
// not a TTY, when NO_COLOR is set, or when the user passes --no-color.

import { AnalysisResult } from "../analyzer";

export interface CliArgs {
  command: string;
  provider: "all" | "claude-code" | "codex";
  json: boolean;
  noColor: boolean;
  noServer: boolean;
  forceServer: boolean;
  pricing: string | null;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function colorEnabled(args: CliArgs): boolean {
  if (args.noColor) return false;
  if (process.env.NO_COLOR) return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

function paint(s: string, code: string, on: boolean): string {
  return on ? `${code}${s}${ANSI.reset}` : s;
}

function header(text: string, on: boolean): string {
  const line = "─".repeat(Math.max(36, text.length));
  return `${paint(text, ANSI.bold, on)}\n${paint(line, ANSI.dim, on)}`;
}

function row(label: string, value: string, labelWidth: number, on: boolean): string {
  return `  ${paint(label.padEnd(labelWidth), ANSI.dim, on)}${value}`;
}

function fmtTokens(n: number): string {
  if (!isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (!isFinite(n) || n <= 0) return "$0.00";
  if (n >= 10_000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 100) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function totalTokens(result: AnalysisResult): number {
  const t = result.totals;
  return t.inTokens + t.outTokens + t.cacheRead + t.cacheWrite;
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function relativeTime(target: Date, now: Date = new Date()): string {
  const diffMs = target.getTime() - now.getTime();
  const future = diffMs >= 0;
  const ms = Math.abs(diffMs);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return future ? "in <1m" : "<1m ago";
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  const remH = hours - days * 24;
  if (future) return remH > 0 ? `in ${days}d ${remH}h` : `in ${days}d`;
  return remH > 0 ? `${days}d ${remH}h ago` : `${days}d ago`;
}

function emptyMessage(text: string, on: boolean): void {
  console.log();
  console.log(paint(`  ${text}`, ANSI.dim, on));
  console.log();
}

export function renderToday(result: AnalysisResult, args: CliArgs): void {
  const c = colorEnabled(args);
  console.log();
  console.log(header(`BurnRate · today (${localDate()})`, c));

  if (result.totals.messages === 0) {
    emptyMessage("No activity recorded yet today.", c);
    return;
  }

  const total = totalTokens(result);
  const claude = result.byProvider["claude-code"];
  const codex = result.byProvider["codex"];

  console.log();
  console.log(row("Tokens", paint(fmtTokens(total), ANSI.cyan, c), 14, c));
  if (claude && claude.tokens > 0) {
    console.log(row("  Claude Code", fmtTokens(claude.tokens), 14, c));
  }
  if (codex && codex.tokens > 0) {
    console.log(row("  Codex", fmtTokens(codex.tokens), 14, c));
  }
  console.log(
    row(
      "Cost",
      paint(fmtUsd(result.totals.cost), ANSI.green, c) + paint(" implied", ANSI.dim, c),
      14,
      c,
    ),
  );
  console.log(row("Sessions", String(result.totals.sessions), 14, c));

  const models = Object.entries(result.byModel).sort((a, b) => b[1].tokens - a[1].tokens);
  if (models.length > 0 && models[0][1].tokens > 0) {
    const [name, stat] = models[0];
    const pct = total > 0 ? Math.round((stat.tokens / total) * 100) : 0;
    console.log();
    console.log(row("Top model", `${name} ${paint(`(${pct}%)`, ANSI.dim, c)}`, 14, c));
  }

  if (result.totals.unknownMessages > 0) {
    console.log();
    console.log(
      paint(
        `  ${result.totals.unknownMessages} message(s) used unpriced models — counted as $0`,
        ANSI.yellow,
        c,
      ),
    );
  }
  console.log();
}

export function renderMonth(result: AnalysisResult, args: CliArgs): void {
  const c = colorEnabled(args);
  console.log();
  console.log(header(`BurnRate · this month (${localMonth()})`, c));

  if (result.totals.messages === 0) {
    emptyMessage("No activity in this month.", c);
    return;
  }

  const total = totalTokens(result);
  const activeDays = Object.values(result.byDay).filter((v) => v > 0).length;
  const days = Object.entries(result.byDay).sort((a, b) => b[1] - a[1]);

  console.log();
  console.log(row("Tokens", paint(fmtTokens(total), ANSI.cyan, c), 14, c));
  console.log(
    row(
      "Cost",
      paint(fmtUsd(result.totals.cost), ANSI.green, c) + paint(" implied", ANSI.dim, c),
      14,
      c,
    ),
  );
  console.log(row("Sessions", String(result.totals.sessions), 14, c));
  console.log(row("Active days", String(activeDays), 14, c));
  if (days.length > 0 && days[0][1] > 0) {
    console.log(row("Top day", `${days[0][0]} — ${fmtUsd(days[0][1])}`, 14, c));
  }

  const projects = Object.values(result.byProject)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);
  if (projects.length > 0 && projects[0].cost > 0) {
    console.log();
    console.log(paint("  Top projects", ANSI.bold, c));
    const totalCost = result.totals.cost;
    for (const p of projects) {
      if (p.cost <= 0) continue;
      const pct = totalCost > 0 ? Math.round((p.cost / totalCost) * 100) : 0;
      const name = p.project.length > 28 ? p.project.slice(0, 27) + "…" : p.project;
      console.log(
        `    ${name.padEnd(28)} ${fmtUsd(p.cost).padStart(8)} ${paint(`(${pct}%)`, ANSI.dim, c)}`,
      );
    }
  }
  console.log();
}

export function renderAll(result: AnalysisResult, args: CliArgs): void {
  const c = colorEnabled(args);
  console.log();
  console.log(header("BurnRate · all time", c));

  if (result.totals.messages === 0) {
    emptyMessage("No activity recorded.", c);
    return;
  }

  const total = totalTokens(result);
  const days = Object.keys(result.byDay).filter((k) => result.byDay[k] > 0).length;

  console.log();
  console.log(row("Tokens", paint(fmtTokens(total), ANSI.cyan, c), 14, c));
  console.log(
    row(
      "Cost",
      paint(fmtUsd(result.totals.cost), ANSI.green, c) + paint(" implied", ANSI.dim, c),
      14,
      c,
    ),
  );
  console.log(row("Sessions", String(result.totals.sessions), 14, c));
  console.log(row("Active days", String(days), 14, c));
  console.log(row("Files scanned", String(result.scannedFiles), 14, c));

  const claude = result.byProvider["claude-code"];
  const codex = result.byProvider["codex"];
  if ((claude && claude.tokens > 0) || (codex && codex.tokens > 0)) {
    console.log();
    console.log(paint("  By provider", ANSI.bold, c));
    if (claude && claude.tokens > 0) {
      console.log(
        `    Claude Code  ${fmtTokens(claude.tokens).padStart(8)} ${fmtUsd(claude.cost).padStart(10)}`,
      );
    }
    if (codex && codex.tokens > 0) {
      console.log(
        `    Codex        ${fmtTokens(codex.tokens).padStart(8)} ${fmtUsd(codex.cost).padStart(10)}`,
      );
    }
  }
  console.log();
}

export function renderQuota(result: AnalysisResult, args: CliArgs): void {
  const c = colorEnabled(args);
  console.log();
  console.log(header("BurnRate · Codex Weekly Quota", c));

  const q = result.codexQuota;
  if (!q) {
    emptyMessage("No Codex quota snapshot found yet — use Codex CLI at least once.", c);
    return;
  }

  const usedColor = q.usedPercent >= 80 ? ANSI.red : q.usedPercent >= 50 ? ANSI.yellow : ANSI.green;
  const usedStr = `${Math.round(q.usedPercent)}%`;

  console.log();
  console.log(
    row("Used", paint(usedStr, usedColor, c) + paint(" of weekly window", ANSI.dim, c), 18, c),
  );
  console.log(row("Window resets", relativeTime(new Date(q.resetsAt)), 18, c));
  console.log(row("Plan", q.planType || "—", 18, c));
  console.log(
    row(
      "Window tokens",
      `${fmtTokens(q.windowTokensUsed)}${paint(" (local logs)", ANSI.dim, c)}`,
      18,
      c,
    ),
  );

  if (q.activeDays7d >= 3) {
    console.log(row("7-day avg", `${fmtTokens(q.avgDailyTokens7d)}/active day`, 18, c));
    if (q.projectedExhaustsAt) {
      const when = relativeTime(new Date(q.projectedExhaustsAt));
      console.log(row("Projection", paint(`exhausts ${when}`, ANSI.red, c), 18, c));
    } else {
      console.log(row("Projection", paint("within window", ANSI.green, c), 18, c));
    }
  } else {
    console.log(
      row("Projection", paint(`needs >=3 active days (have ${q.activeDays7d})`, ANSI.dim, c), 18, c),
    );
  }

  if (q.recentLimitExceededCount > 0) {
    console.log();
    console.log(paint(`  Hit limit ${q.recentLimitExceededCount}x recently`, ANSI.yellow, c));
    if (q.mostRecentLimitExceededAt) {
      console.log(
        paint(
          `  Most recent: ${relativeTime(new Date(q.mostRecentLimitExceededAt))}`,
          ANSI.dim,
          c,
        ),
      );
    }
  }
  console.log();
}

export function printError(message: string): void {
  const on = !process.env.NO_COLOR && process.stderr.isTTY;
  process.stderr.write(`${paint("error", ANSI.red, on)}: ${message}\n`);
}

/**
 * Printed after the terminal summary once the local dashboard server is
 * listening. The blank line above keeps it visually separate from the
 * data; we deliberately don't auto-open a browser.
 */
export function printServerHint(url: string, args: CliArgs): void {
  const c = !args.noColor && !process.env.NO_COLOR && process.stdout.isTTY;
  console.log(
    `  ${paint("→", ANSI.dim, c)} ${paint("Open in browser", ANSI.dim, c)}: ${paint(url, ANSI.cyan, c)}`,
  );
  console.log(`  ${paint("(Ctrl+C to quit)", ANSI.dim, c)}`);
  console.log();
}
