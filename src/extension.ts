import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { analyze, defaultClaudeRoot } from "./analyzer";
import { PricingTable, sanitizePricing, ModelPrice, BUILTIN_PRICING } from "./pricing";

let panel: vscode.WebviewPanel | undefined;
let currentRange: "today" | "month" | "all" = "month";

const LEGACY_DEPRECATION_FLAG = "burnRate.legacyDeprecationShown.v1";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    // Primary commands.
    vscode.commands.registerCommand("burnRate.showDashboard", () => showDashboard(context)),
    vscode.commands.registerCommand("burnRate.refresh", () => {
      if (panel) postData(context, panel, currentRange);
      else showDashboard(context);
    }),
    // Legacy aliases for users with existing keybindings / menus from the
    // Claude Cost Tracker era. Registering both lets us drop the legacy
    // command IDs in v3.0 without breaking installs in the meantime.
    vscode.commands.registerCommand("claudeCostTracker.showDashboard", () => showDashboard(context)),
    vscode.commands.registerCommand("claudeCostTracker.refresh", () => {
      if (panel) postData(context, panel, currentRange);
      else showDashboard(context);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        panel &&
        (e.affectsConfiguration("burnRate") || e.affectsConfiguration("claudeCostTracker"))
      ) {
        postData(context, panel, currentRange);
      }
    }),
  );

  void maybeShowLegacyDeprecation(context);
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
      currentRange = msg.range;
      await postData(context, panel!, currentRange);
    } else if (msg?.type === "ready") {
      await postData(context, panel!, currentRange);
    } else if (msg?.type === "openSettings") {
      vscode.commands.executeCommand("workbench.action.openSettings", "burnRate");
    }
  });
  panel.webview.html = renderHtml(context, panel.webview);
  panel.onDidDispose(() => { panel = undefined; });
}

async function postData(context: vscode.ExtensionContext, p: vscode.WebviewPanel, range: "today" | "month" | "all") {
  const requestId = nextRequestId();
  try {
    const customPricing: Record<string, ModelPrice> = sanitizePricing(
      readConfigValue<Record<string, unknown>>("customPricing", {}),
    );
    const rawSpikeThreshold = readConfigValue<unknown>("spikeThresholdUsd", 1.0);
    const spikeThreshold: number =
      typeof rawSpikeThreshold === "number" && isFinite(rawSpikeThreshold) ? rawSpikeThreshold : 1.0;
    const pricing = new PricingTable(customPricing);
    const since = sinceFor(range);
    const result = await analyze(defaultClaudeRoot(), {
      since,
      pricing,
      spikeThreshold,
      includeHourBuckets: range === "today",
      includeBucketModels: range === "today" ? "hour" : "day",
    });

    p.webview.postMessage({
      type: "data",
      requestId,
      range,
      result,
      rootExists: fs.existsSync(defaultClaudeRoot()),
      pricingMeta: {
        customCount: Object.keys(customPricing).length,
        builtinCount: Object.keys(BUILTIN_PRICING).length,
        spikeThreshold,
      },
    });
  } catch (err: any) {
    p.webview.postMessage({ type: "error", requestId, message: err?.message || String(err) });
  }
}

/**
 * Read a config key from the new `burnRate` namespace, falling back to the
 * legacy `claudeCostTracker` namespace. A value is considered "set" only
 * when the user has explicitly configured it at any scope (global /
 * workspace / folder); the schema's default never wins over a real legacy
 * value.
 */
function readConfigValue<T>(key: string, fallback: T): T {
  const newCfg = vscode.workspace.getConfiguration("burnRate");
  const newInspect = newCfg.inspect<T>(key);
  if (newInspect && hasExplicitValue(newInspect)) {
    return newCfg.get<T>(key, fallback);
  }
  const oldCfg = vscode.workspace.getConfiguration("claudeCostTracker");
  const oldInspect = oldCfg.inspect<T>(key);
  if (oldInspect && hasExplicitValue(oldInspect)) {
    return oldCfg.get<T>(key, fallback);
  }
  return newCfg.get<T>(key, fallback);
}

function hasExplicitValue<T>(inspect: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T }): boolean {
  return (
    inspect.globalValue !== undefined ||
    inspect.workspaceValue !== undefined ||
    inspect.workspaceFolderValue !== undefined
  );
}

async function maybeShowLegacyDeprecation(context: vscode.ExtensionContext) {
  if (context.globalState.get<boolean>(LEGACY_DEPRECATION_FLAG)) return;
  const oldCfg = vscode.workspace.getConfiguration("claudeCostTracker");
  const legacyKeys = ["customPricing", "spikeThresholdUsd"];
  const populated = legacyKeys.some((k) => {
    const i = oldCfg.inspect(k);
    return !!i && hasExplicitValue(i);
  });
  if (!populated) return;
  const choice = await vscode.window.showInformationMessage(
    "BurnRate: settings have moved from `claudeCostTracker.*` to `burnRate.*`. Legacy keys are still read but will be removed in v3.0.",
    "Open Settings",
    "Don't show again",
  );
  if (choice === "Open Settings") {
    vscode.commands.executeCommand("workbench.action.openSettings", "burnRate");
  }
  if (choice === "Don't show again" || choice === "Open Settings") {
    await context.globalState.update(LEGACY_DEPRECATION_FLAG, true);
  }
}

let requestSeq = 0;
function nextRequestId(): number {
  requestSeq = (requestSeq + 1) % Number.MAX_SAFE_INTEGER;
  return requestSeq;
}

function sinceFor(range: "today" | "month" | "all"): string | undefined {
  const now = new Date();
  if (range === "today") return localDateKey(now);
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

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
