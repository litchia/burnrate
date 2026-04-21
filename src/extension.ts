import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { analyze, defaultClaudeRoot } from "./analyzer";
import { PricingTable, sanitizePricing, ModelPrice } from "./pricing";
import { loadRemotePricing, RemoteLoadResult } from "./remotePricing";

const DEFAULT_COMMUNITY_PRICING_URL =
  "https://gist.githubusercontent.com/litchia/81a8014f27784b0ac8333f6371b6bb41/raw/llm-api-pricing.json";

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
  panel.webview.html = renderHtml(context, panel.webview);
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
  panel.onDidDispose(() => { panel = undefined; });
}

async function postData(context: vscode.ExtensionContext, p: vscode.WebviewPanel, range: "today" | "month" | "all") {
  try {
    const cfg = vscode.workspace.getConfiguration("claudeCostTracker");
    const customPricing: Record<string, ModelPrice> = sanitizePricing(cfg.get("customPricing") ?? {});
    const useCommunity: boolean = cfg.get("useCommunityPricing") ?? false;
    const userPricingUrl: string = (cfg.get("pricingUrl") as string) ?? "";
    const spikeThreshold: number = (cfg.get("spikeThresholdUsd") as number) ?? 1.0;

    let remote: Record<string, ModelPrice> = {};
    let remoteInfo: RemoteLoadResult | null = null;
    let resolvedUrl = userPricingUrl.trim() || (useCommunity ? DEFAULT_COMMUNITY_PRICING_URL : "");

    if (resolvedUrl) {
      const cacheDir = context.globalStorageUri.fsPath;
      remoteInfo = await loadRemotePricing(resolvedUrl, cacheDir);
      remote = remoteInfo.data;
    }

    const pricing = new PricingTable(customPricing, remote);
    const since = sinceFor(range);
    const result = await analyze(defaultClaudeRoot(), { since, pricing, spikeThreshold });

    p.webview.postMessage({
      type: "data",
      range,
      result,
      rootExists: fs.existsSync(defaultClaudeRoot()),
      pricingMeta: {
        customCount: Object.keys(customPricing).length,
        remoteCount: Object.keys(remote).length,
        remoteUrl: resolvedUrl || null,
        remoteSource: remoteInfo?.source ?? null,
        remoteFetchedAt: remoteInfo?.fetchedAt ?? null,
        remoteError: remoteInfo?.error ?? null,
        useCommunity,
      },
    });
  } catch (err: any) {
    p.webview.postMessage({ type: "error", message: err?.message || String(err) });
  }
}

function sinceFor(range: "today" | "month" | "all"): string | undefined {
  const now = new Date();
  if (range === "today") return now.toISOString().slice(0, 10);
  if (range === "month") {
    const y = now.getUTCFullYear();
    const m = String(now.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }
  return undefined;
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
