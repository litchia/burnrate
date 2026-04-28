// Status bar item for BurnRate.
//
// Shows a compact glanceable summary of today's implied spend in the bottom-
// right status bar. Clicking opens the dashboard. Refreshes on activation,
// config changes, explicit refresh commands, and on a periodic timer.
//
// Design constraints baked in here:
// - Aggregation is always async and never blocks activation.
// - We call the smallest analyzer range available (`since` = today) so we
//   don't re-scan the entire log tree every tick.
// - If aggregation throws, we keep the last-known label — never show an
//   error state in the status bar itself.
// - Toggling `burnRate.showStatusBar` fully disposes the StatusBarItem when
//   hidden, not just visually hidden.
// - All paths go through `vscode.workspace.getConfiguration` — no string
//   concatenation of filesystem paths.

import * as vscode from "vscode";
import { analyzeForProvider, ProviderFilter } from "./analyzer";
import { PricingTable, sanitizePricing, ModelPrice } from "./pricing";
import * as i18n from "./i18n";

const DEFAULT_REFRESH_SECONDS = 300;
const MIN_REFRESH_SECONDS = 30;

interface TodaySnapshot {
  totalCost: number;
  totalTokens: number;
  claudeTokens: number;
  codexTokens: number;
  hasData: boolean;
  sampledAt: Date;
}

class BurnRateStatusBar {
  private item: vscode.StatusBarItem | undefined;
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private lastSnapshot: TodaySnapshot | undefined;
  private disposed = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Apply current `burnRate.showStatusBar` setting: create or dispose the item. */
  applyVisibility(): void {
    if (this.disposed) return;
    if (this.isEnabled()) {
      this.ensureItem();
      this.renderFromSnapshot();
      void this.refresh();
      this.restartTimer();
    } else {
      this.tearDown();
    }
  }

  /** Re-read today's aggregation and update the label. No-op when hidden. */
  async refresh(): Promise<void> {
    if (this.disposed || !this.item || this.inFlight) return;
    this.inFlight = true;
    try {
      const snapshot = await this.aggregateToday();
      this.lastSnapshot = snapshot;
      this.renderFromSnapshot();
    } catch (err) {
      // Keep last-known label; never surface errors in the status bar itself.
      console.error("[BurnRate] status bar refresh failed:", err);
    } finally {
      this.inFlight = false;
    }
  }

  /** Called on any burnRate.* config change — may flip visibility or refresh interval. */
  handleConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (this.disposed) return;
    if (!e.affectsConfiguration("burnRate")) return;
    // Visibility toggle or interval change.
    this.applyVisibility();
    // Pricing / threshold changes affect today's cost.
    if (this.item) void this.refresh();
  }

  /** Re-render chrome (tooltip) when the locale flips. Data is unchanged. */
  handleLocaleChange(): void {
    this.renderFromSnapshot();
  }

  dispose(): void {
    this.disposed = true;
    this.tearDown();
  }

  // --- internals ----------------------------------------------------------

  private isEnabled(): boolean {
    return readConfigBool("showStatusBar", true);
  }

  private ensureItem(): void {
    if (this.item) return;
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    item.command = "burnRate.showDashboard";
    item.name = "BurnRate";
    item.text = "$(flame) BurnRate";
    item.tooltip = this.buildTooltip(undefined);
    item.show();
    this.item = item;
  }

  private tearDown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.item) {
      this.item.dispose();
      this.item = undefined;
    }
  }

  private restartTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const seconds = this.refreshSeconds();
    this.timer = setInterval(() => {
      void this.refresh();
    }, seconds * 1000);
  }

  private refreshSeconds(): number {
    const raw = readConfigValue<unknown>("statusBarRefreshSeconds", DEFAULT_REFRESH_SECONDS);
    const n = typeof raw === "number" && isFinite(raw) ? Math.floor(raw) : DEFAULT_REFRESH_SECONDS;
    return Math.max(MIN_REFRESH_SECONDS, n);
  }

  private renderFromSnapshot(): void {
    if (!this.item) return;
    const snap = this.lastSnapshot;
    this.item.text = formatStatusText(snap);
    this.item.tooltip = this.buildTooltip(snap);
  }

  private buildTooltip(snap: TodaySnapshot | undefined): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = false;
    md.supportThemeIcons = true;
    const today = localDateLabel(snap?.sampledAt ?? new Date());
    md.appendMarkdown(`**${i18n.t("BurnRate · today")}** — ${today}\n\n`);
    if (!snap || !snap.hasData) {
      md.appendMarkdown(i18n.t("No activity recorded yet today.") + "\n\n");
    } else {
      if (snap.claudeTokens > 0) {
        md.appendMarkdown(
          i18n.t("Claude Code: {0} tokens", formatTokens(snap.claudeTokens)) + "  \n",
        );
      }
      if (snap.codexTokens > 0) {
        md.appendMarkdown(
          i18n.t("Codex: {0} tokens", formatTokens(snap.codexTokens)) + "  \n",
        );
      }
      if (snap.totalCost > 0) {
        md.appendMarkdown(
          i18n.t("Total implied spend: {0}", formatUsd(snap.totalCost)) + "  \n",
        );
      }
      md.appendMarkdown("\n");
    }
    md.appendMarkdown(i18n.t("Click to open dashboard."));
    return md;
  }

  private async aggregateToday(): Promise<TodaySnapshot> {
    const customPricing: Record<string, ModelPrice> = sanitizePricing(
      readConfigValue<Record<string, unknown>>("customPricing", {}),
    );
    const rawSpikeThreshold = readConfigValue<unknown>("spikeThresholdUsd", 1.0);
    const spikeThreshold: number =
      typeof rawSpikeThreshold === "number" && isFinite(rawSpikeThreshold)
        ? rawSpikeThreshold
        : 1.0;
    const pricing = new PricingTable(customPricing);
    const since = todayKey();
    const provider: ProviderFilter = "all";
    const result = await analyzeForProvider(provider, {
      since,
      pricing,
      spikeThreshold,
      includeHourBuckets: false,
      includeBucketModels: "none",
    });
    const claudeTokens = result.byProvider["claude-code"]?.tokens ?? 0;
    const codexTokens = result.byProvider["codex"]?.tokens ?? 0;
    const totalCost = result.totals.cost;
    const totalTokens =
      result.totals.inTokens +
      result.totals.outTokens +
      result.totals.cacheRead +
      result.totals.cacheWrite;
    return {
      totalCost,
      totalTokens,
      claudeTokens,
      codexTokens,
      hasData: result.totals.messages > 0,
      sampledAt: new Date(),
    };
  }
}

export function registerStatusBar(context: vscode.ExtensionContext): {
  refresh: () => Promise<void>;
  handleConfigChange: (e: vscode.ConfigurationChangeEvent) => void;
  handleLocaleChange: () => void;
} {
  const bar = new BurnRateStatusBar(context);
  context.subscriptions.push({ dispose: () => bar.dispose() });
  bar.applyVisibility();
  return {
    refresh: () => bar.refresh(),
    handleConfigChange: (e) => bar.handleConfigChange(e),
    handleLocaleChange: () => bar.handleLocaleChange(),
  };
}

// --- formatting helpers ---------------------------------------------------

function formatStatusText(snap: TodaySnapshot | undefined): string {
  if (!snap || !snap.hasData) return "$(flame) BurnRate";
  if (snap.totalTokens > 0) return `$(flame) ${formatTokens(snap.totalTokens)}`;
  return "$(flame) BurnRate";
}

function formatUsd(value: number): string {
  if (!isFinite(value) || value <= 0) return "$0.00";
  if (value >= 1000) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 100) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (!isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function localDateLabel(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- config helpers -------------------------------------------------------

function readConfigValue<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("burnRate").get<T>(key, fallback);
}

function readConfigBool(key: string, fallback: boolean): boolean {
  const v = readConfigValue<unknown>(key, fallback);
  return typeof v === "boolean" ? v : fallback;
}
