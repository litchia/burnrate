// Command implementations for the BurnRate CLI.
//
// Each command:
//   1. Runs the analyzer for the requested range and prints a terminal
//      summary (or JSON when --json is set).
//   2. If interactive (TTY + non-JSON + --no-server not passed), starts
//      the local dashboard server, prints the URL line, and blocks on
//      SIGINT. The server runs the analyzer fresh per request, so range
//      and provider switches in the browser stay accurate.

import * as fs from "fs";
import { analyzeForProvider, ProviderFilter } from "../analyzer";
import { ModelPrice, PricingTable, sanitizePricing } from "../pricing";
import {
  CliArgs,
  printError,
  printServerHint,
  renderAll,
  renderMonth,
  renderQuota,
  renderToday,
} from "./format";
import { DashboardRange, startServer, ServerHandle } from "./server";

const VERSION: string = require("../../package.json").version;

interface PricingResolution {
  table: PricingTable;
  customCount: number;
}

function loadPricing(pricingPath: string | null): PricingResolution {
  if (!pricingPath) return { table: new PricingTable({}), customCount: 0 };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(pricingPath, "utf8"));
  } catch (e: any) {
    throw new Error(`failed to read --pricing file ${pricingPath}: ${e.message || e}`);
  }
  const map =
    raw && typeof raw === "object" && "customPricing" in (raw as Record<string, unknown>)
      ? (raw as { customPricing: unknown }).customPricing
      : raw;
  const sanitized: Record<string, ModelPrice> = sanitizePricing(map as Record<string, unknown>);
  return { table: new PricingTable(sanitized), customCount: Object.keys(sanitized).length };
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function weekKey(): string {
  // Rolling 7-day window ending today, inclusive — the design's "this
  // week" pill follows the dashboard convention more than ISO weeks.
  const d = new Date();
  d.setDate(d.getDate() - 6);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sinceForRange(range: DashboardRange): string | undefined {
  if (range === "today") return todayKey();
  if (range === "week") return weekKey();
  if (range === "month") return monthKey();
  return undefined;
}

interface RunOptions {
  provider?: ProviderFilter;
  since?: string;
  includeBucketModels?: "none" | "day";
  includeHourBuckets?: boolean;
}

function runAnalyzer(
  pricing: PricingTable,
  args: CliArgs,
  options: RunOptions,
): ReturnType<typeof analyzeForProvider> {
  const provider = options.provider ?? args.provider;
  return analyzeForProvider(provider, {
    since: options.since,
    pricing,
    includeHourBuckets: options.includeHourBuckets ?? false,
    includeBucketModels: options.includeBucketModels ?? "none",
  });
}

function shouldStartServer(args: CliArgs): boolean {
  if (args.json) return false;
  if (args.noServer) return false;
  if (args.forceServer) return true;
  if (!process.stdout.isTTY) return false;
  return true;
}

/**
 * Stand the dashboard up and block until SIGINT. Stops cleanly so
 * downstream callers can `await` and exit.
 */
async function serveAndWait(args: CliArgs, pricing: PricingResolution): Promise<void> {
  // CLI users set their monthly budget via env var; the VS Code
  // extension threads it through `burnRate.monthlyBudget`. Both end
  // up in pricingMeta so the webview hero card can render the bar.
  const rawBudget = Number(process.env.BURNRATE_MONTHLY_BUDGET);
  const monthlyBudget = isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 0;
  const handle = await startServer({
    cliVersion: VERSION,
    customPricingCount: pricing.customCount,
    initialProvider: args.provider,
    monthlyBudget,
    analyze: (range, provider) =>
      runAnalyzer(pricing.table, args, {
        provider,
        since: sinceForRange(range),
        includeHourBuckets: range === "today",
        includeBucketModels: range === "today" ? "none" : "day",
      }),
  });
  printServerHint(handle.url, args);
  await waitForSignal(handle);
}

function waitForSignal(handle: ServerHandle): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = async () => {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      await handle.stop();
      resolve();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

export async function runToday(args: CliArgs): Promise<void> {
  const pricing = loadPricing(args.pricing);
  const result = await runAnalyzer(pricing.table, args, { since: todayKey() });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  renderToday(result, args);
  if (shouldStartServer(args)) await serveAndWait(args, pricing);
}

export async function runMonth(args: CliArgs): Promise<void> {
  const pricing = loadPricing(args.pricing);
  const result = await runAnalyzer(pricing.table, args, {
    since: monthKey(),
    includeBucketModels: "day",
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  renderMonth(result, args);
  if (shouldStartServer(args)) await serveAndWait(args, pricing);
}

export async function runAll(args: CliArgs): Promise<void> {
  const pricing = loadPricing(args.pricing);
  const result = await runAnalyzer(pricing.table, args, {});
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  renderAll(result, args);
  if (shouldStartServer(args)) await serveAndWait(args, pricing);
}

export async function runQuota(args: CliArgs): Promise<void> {
  const pricing = loadPricing(args.pricing);
  // Quota is Codex-only by definition; force codex regardless of --provider.
  const result = await runAnalyzer(pricing.table, args, { provider: "codex" });
  if (args.json) {
    process.stdout.write(JSON.stringify(result.codexQuota, null, 2) + "\n");
    return;
  }
  renderQuota(result, args);
  if (shouldStartServer(args)) await serveAndWait(args, pricing);
}

export { printError };
