import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { analyzeForProvider, ProviderFilter, defaultClaudeRoot, defaultCodexRoot } from "./analyzer";
import { PricingTable, sanitizePricing, ModelPrice, BUILTIN_PRICING } from "./pricing";
import * as i18n from "./i18n";
import { registerStatusBar } from "./statusBar";

let panel: vscode.WebviewPanel | undefined;
let currentRange: "today" | "week" | "month" | "all" = "month";
let currentProvider: ProviderFilter = "all";

export function activate(context: vscode.ExtensionContext) {
  const statusBar = registerStatusBar(context);

  context.subscriptions.push(
    i18n.init(context),
    i18n.onDidChangeLocale(() => {
      statusBar.handleLocaleChange();
      if (!panel) return;
      // Push the new dict so the webview can re-render in place; then resend
      // the analysis so any server-formatted strings (none right now, but
      // future-proof) also pick up the new locale.
      panel.webview.postMessage({ type: "i18n", bundle: i18n.getBundleForWebview(), locale: i18n.getActiveLocale() });
      void postData(context, panel, currentRange, currentProvider);
    }),
    vscode.commands.registerCommand("burnRate.showDashboard", () => showDashboard(context)),
    vscode.commands.registerCommand("burnRate.refresh", () => {
      void statusBar.refresh();
      if (panel) postData(context, panel, currentRange, currentProvider);
      else showDashboard(context);
    }),
    vscode.commands.registerCommand("burnRate.ignoreModel", async (model?: string) => {
      await ignoreUnpricedModel(String(model || ""));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      statusBar.handleConfigChange(e);
      if (panel && e.affectsConfiguration("burnRate")) {
        postData(context, panel, currentRange, currentProvider);
      }
    }),
  );
}

export function deactivate() {}

function showDashboard(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel(
    "burnRate",
    "BurnRate",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "src"))],
    },
  );
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "setRange") {
      currentRange = normalizeRange(msg.range);
      if (msg.provider) currentProvider = normalizeProvider(msg.provider);
      await postData(context, panel!, currentRange, currentProvider);
    } else if (msg?.type === "setProvider") {
      currentProvider = normalizeProvider(msg.provider);
      await postData(context, panel!, currentRange, currentProvider);
    } else if (msg?.type === "ready") {
      currentProvider = normalizeProvider(msg.provider);
      if (msg.range) currentRange = normalizeRange(msg.range);
      await postData(context, panel!, currentRange, currentProvider);
    } else if (msg?.type === "setLocale") {
      // Forward to the i18n module; it broadcasts an `i18n` message back.
      i18n.setOverride(typeof msg.locale === "string" ? msg.locale : null);
    } else if (msg?.type === "openSettings") {
      vscode.commands.executeCommand("workbench.action.openSettings", "burnRate");
    } else if (msg?.type === "ignoreModel") {
      await ignoreUnpricedModel(typeof msg.model === "string" ? msg.model : "");
    }
  });
  panel.webview.html = renderHtml(context, panel.webview);
  panel.onDidDispose(() => { panel = undefined; });
}

async function postData(
  context: vscode.ExtensionContext,
  p: vscode.WebviewPanel,
  range: "today" | "week" | "month" | "all",
  provider: ProviderFilter,
) {
  const requestId = nextRequestId();
  try {
    const customPricing: Record<string, ModelPrice> = sanitizePricing(
      readConfigValue<Record<string, unknown>>("customPricing", {}),
    );
    const rawSpikeThreshold = readConfigValue<unknown>("spikeThresholdUsd", 1.0);
    const spikeThreshold: number =
      typeof rawSpikeThreshold === "number" && isFinite(rawSpikeThreshold) ? rawSpikeThreshold : 1.0;
    const ignoredUnpricedModels = normalizeStringArray(
      readConfigValue<unknown>("ignoredUnpricedModels", []),
    );
    const rawBudget = readConfigValue<unknown>("monthlyBudget", 0);
    const monthlyBudget: number =
      typeof rawBudget === "number" && isFinite(rawBudget) && rawBudget > 0 ? rawBudget : 0;
    const pricing = new PricingTable(customPricing);
    const since = sinceFor(range);
    const result = await analyzeForProvider(provider, {
      since,
      pricing,
      spikeThreshold,
      // For "week" we still want byDay buckets (heatmap + sparkline), so
      // mirror the "month" treatment instead of the "today" hour buckets.
      includeHourBuckets: range === "today",
      includeBucketModels: range === "today" ? "hour" : "day",
    });
    const rootStatus = {
      "claude-code": fs.existsSync(defaultClaudeRoot()),
      codex: fs.existsSync(defaultCodexRoot()),
    };

    p.webview.postMessage({
      type: "data",
      requestId,
      range,
      provider,
      result,
      rootExists: rootStatus["claude-code"] || rootStatus.codex,
      rootStatus,
      pricingMeta: {
        customCount: Object.keys(customPricing).length,
        builtinCount: Object.keys(BUILTIN_PRICING).length,
        spikeThreshold,
        ignoredUnpricedModels,
        monthlyBudget,
      },
      i18n: i18n.getBundleForWebview(),
      locale: i18n.getActiveLocale(),
    });
  } catch (err: any) {
    p.webview.postMessage({ type: "error", requestId, message: err?.message || String(err) });
  }
}

function normalizeProvider(value: unknown): ProviderFilter {
  return value === "claude-code" || value === "codex" ? value : "all";
}

function normalizeRange(value: unknown): "today" | "week" | "month" | "all" {
  if (value === "today" || value === "week" || value === "month" || value === "all") return value;
  return "month";
}

function readConfigValue<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration("burnRate").get<T>(key, fallback);
}

let requestSeq = 0;
function nextRequestId(): number {
  requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
  return requestSeq;
}

function sinceFor(range: "today" | "week" | "month" | "all"): string | undefined {
  const now = new Date();
  if (range === "today") return localDateKey(now);
  if (range === "week") {
    // 7-day rolling window inclusive of today.
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    return localDateKey(start);
  }
  if (range === "month") {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }
  return undefined;
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderHtml(context: vscode.ExtensionContext, webview: vscode.Webview): string {
  const htmlPath = path.join(context.extensionPath, "src", "webview", "index.html");
  const jsPath   = path.join(context.extensionPath, "src", "webview", "main.js");
  const html = fs.readFileSync(htmlPath, "utf8");
  const js   = fs.readFileSync(jsPath, "utf8");
  const nonce = makeNonce();
  return html
    .split("{{NONCE}}").join(nonce)
    .split("{{CSP_SOURCE}}").join(webview.cspSource)
    .split("{{INLINE_JS}}").join(js);
}

async function ignoreUnpricedModel(model: string): Promise<void> {
  const normalized = model.trim();
  if (!normalized) return;
  const destinations = resolvePreferredConfigDestinations("ignoredUnpricedModels");
  if (destinations.every((destination) => destination.current.includes(normalized))) return;
  for (const destination of destinations) {
    const next = destination.current.includes(normalized)
      ? destination.current
      : [...destination.current, normalized];
    await vscode.workspace
      .getConfiguration("burnRate", destination.resource)
      .update("ignoredUnpricedModels", next, destination.target);
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item, index, list) => item.length > 0 && list.indexOf(item) === index);
}

function resolvePreferredConfigDestinations(
  key: string,
): Array<{ target: vscode.ConfigurationTarget; resource?: vscode.Uri; current: string[] }> {
  const folderDestinations: Array<{ target: vscode.ConfigurationTarget; resource?: vscode.Uri; current: string[] }> = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const cfg = vscode.workspace.getConfiguration("burnRate", folder.uri);
    const inspect = cfg.inspect(key);
    if (inspect?.workspaceFolderValue !== undefined) {
      folderDestinations.push({
        target: vscode.ConfigurationTarget.WorkspaceFolder,
        resource: folder.uri,
        current: normalizeStringArray(cfg.get<unknown>(key, [])),
      });
    }
  }
  if (folderDestinations.length > 0) return folderDestinations;
  const cfg = vscode.workspace.getConfiguration("burnRate");
  const inspect = cfg.inspect(key);
  if (inspect?.workspaceValue !== undefined) {
    return [{ target: vscode.ConfigurationTarget.Workspace, current: normalizeStringArray(cfg.get<unknown>(key, [])) }];
  }
  return [{ target: vscode.ConfigurationTarget.Global, current: normalizeStringArray(cfg.get<unknown>(key, [])) }];
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
