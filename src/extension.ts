import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { analyze, defaultClaudeRoot } from "./analyzer";
import { PricingTable, sanitizePricing, ModelPrice, BUILTIN_PRICING } from "./pricing";

let panel: vscode.WebviewPanel | undefined;
let currentRange: "today" | "month" | "all" = "month";

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claudeCostTracker.showDashboard", () => showDashboard(context)),
    vscode.commands.registerCommand("claudeCostTracker.refresh", () => {
      if (panel) postData(context, panel, currentRange);
      else showDashboard(context);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeCostTracker") && panel) {
        postData(context, panel, currentRange);
      }
    }),
  );
}

export function deactivate() {}

function showDashboard(context: vscode.ExtensionContext) {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel(
    "claudeCostTracker",
    "Claude Cost Tracker",
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
      vscode.commands.executeCommand("workbench.action.openSettings", "claudeCostTracker");
    }
  });
  panel.webview.html = renderHtml(context, panel.webview);
  panel.onDidDispose(() => { panel = undefined; });
}

async function postData(context: vscode.ExtensionContext, p: vscode.WebviewPanel, range: "today" | "month" | "all") {
  const requestId = nextRequestId();
  try {
    const cfg = vscode.workspace.getConfiguration("claudeCostTracker");
    const customPricing: Record<string, ModelPrice> = sanitizePricing(cfg.get("customPricing") ?? {});
    const rawSpikeThreshold = cfg.get("spikeThresholdUsd");
    const spikeThreshold: number = typeof rawSpikeThreshold === "number" && isFinite(rawSpikeThreshold) ? rawSpikeThreshold : 1.0;
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
