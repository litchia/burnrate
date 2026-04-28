// Local HTTP server for the BurnRate CLI dashboard.
//
// Hosts the same single-file webview UI shipped inside the VS Code
// extension (src/webview/index.html + main.js) so the browser-side
// dashboard has full feature parity: provider/range pills, calendar +
// hourly heatmaps, project list, model breakdown, spike turns, Codex
// quota card, unknown-pricing banner. A small bridge shim (bridge.ts)
// translates the webview's `vscode.postMessage` protocol into fetches
// against `/api/data`, so we don't have to fork or rewrite the webview.
//
// The server runs the analyzer fresh per request — pricing and provider
// filter come from a closure passed by the CLI, so we never hard-code
// either here.

import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { AddressInfo } from "net";
import {
  AnalysisResult,
  defaultClaudeRoot,
  defaultCodexRoot,
} from "../analyzer";
import { BUILTIN_PRICING } from "../pricing";
import { BRIDGE_JS } from "./bridge";

const PORT_START = 5757;
const PORT_END = 5765;

export type DashboardRange = "today" | "month" | "all";

export interface ServerOptions {
  /**
   * Run the analyzer for the given range / provider and return the raw
   * AnalysisResult. The CLI owns pricing, ignored-models, and other
   * config; we just shape the network request.
   */
  analyze: (range: DashboardRange, provider: "all" | "claude-code" | "codex") => Promise<AnalysisResult>;
  cliVersion: string;
  /** From --pricing: Object.keys(customPricing).length. Used for the
   *  pricing-source meta line at the bottom of the webview. */
  customPricingCount: number;
  /** From --provider on the CLI invocation; used as the initial pill. */
  initialProvider: "all" | "claude-code" | "codex";
}

export interface ServerHandle {
  url: string;
  stop: () => Promise<void>;
}

interface Assets {
  html: string;
  i18n: Record<string, Record<string, string>>;
}

function findAsset(relPath: string): string {
  // Three layouts to support:
  //   1. published pkg: <pkg>/dist/cli/server.js → <pkg>/dist/<rel>
  //      e.g. dist/webview/index.html, dist/l10n/bundle.l10n.en.json
  //   2. dev tree, webview: <repo>/out/cli/server.js → <repo>/src/<rel>
  //      e.g. src/webview/index.html
  //   3. dev tree, l10n:    <repo>/out/cli/server.js → <repo>/<rel>
  //      e.g. l10n/bundle.l10n.en.json
  const candidates = [
    path.join(__dirname, "..", relPath),
    path.join(__dirname, "..", "..", "src", relPath),
    path.join(__dirname, "..", "..", relPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`asset not found for ${relPath}; tried:\n  ${candidates.join("\n  ")}`);
}

function loadAssets(opts: ServerOptions): Assets {
  const indexHtml = fs.readFileSync(findAsset(path.join("webview", "index.html")), "utf8");
  const mainJs = fs.readFileSync(findAsset(path.join("webview", "main.js")), "utf8");

  const enBundle: Record<string, string> = JSON.parse(
    fs.readFileSync(findAsset(path.join("l10n", "bundle.l10n.en.json")), "utf8"),
  );
  const zhBundle: Record<string, string> = JSON.parse(
    fs.readFileSync(findAsset(path.join("l10n", "bundle.l10n.zh-cn.json")), "utf8"),
  );

  // Drop the `_comment` keys before shipping to the browser.
  delete enBundle._comment;
  delete zhBundle._comment;
  const i18n = { en: enBundle, "zh-cn": zhBundle };

  // Initial language: `zh-cn` if any of the user's env lang variables
  // start with `zh`. The browser-side `localStorage` value still wins
  // once the user has picked one — this is just the first-paint default.
  const envLang = (
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    process.env.LANG ||
    process.env.LANGUAGE ||
    ""
  ).toLowerCase();
  const initialLang = envLang.startsWith("zh") ? "zh-cn" : "en";

  // Bake the bridge shim before main.js, with the i18n bundles inlined.
  const bridgeFinal = BRIDGE_JS
    .replace("__BURNRATE_I18N__", JSON.stringify(i18n))
    .replace("__BURNRATE_INITIAL_LANG__", JSON.stringify(initialLang));
  const inlineJs = bridgeFinal + "\n" + mainJs;

  // The webview's CSP has `script-src 'nonce-{{NONCE}}'` and an inline
  // `<script nonce="{{NONCE}}">{{INLINE_JS}}</script>` template. We
  // generate a fresh nonce per page so the served HTML satisfies the
  // same CSP without weakening it. We also relax `default-src` to allow
  // `connect-src 'self'` for our /api/data fetches.
  const nonce = makeNonce();
  let html = indexHtml
    .split("{{NONCE}}").join(nonce)
    .split("{{INLINE_JS}}").join(inlineJs);

  // Augment the existing CSP to allow same-origin fetch.
  html = html.replace(
    /default-src 'none';/,
    "default-src 'none'; connect-src 'self'; img-src data:;",
  );

  // The injected language pills inherit the redesigned `.pill.active`
  // styles directly — no extra CSS needed.

  // Stash CLI metadata for the pricingMeta payload.
  void opts;

  return { html, i18n };
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function buildPricingMeta(opts: ServerOptions): {
  customCount: number;
  builtinCount: number;
  spikeThreshold: number;
  ignoredUnpricedModels: string[];
} {
  return {
    customCount: opts.customPricingCount,
    builtinCount: Object.keys(BUILTIN_PRICING).length,
    spikeThreshold: 1.0,
    ignoredUnpricedModels: [],
  };
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const assets = loadAssets(opts);

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Loopback-only safety: reject Host headers that aren't local.
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
      res.statusCode = 403;
      res.end("BurnRate CLI dashboard only serves loopback hosts.");
      return;
    }

    const url = req.url ?? "/";

    if (url === "/" || url.startsWith("/?") || url.startsWith("/#")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(assets.html);
      return;
    }

    if (url.startsWith("/api/data")) {
      const u = new URL("http://x" + url);
      const range = (u.searchParams.get("range") || "month") as DashboardRange;
      if (range !== "today" && range !== "month" && range !== "all") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid range" }));
        return;
      }
      const providerParam = u.searchParams.get("provider");
      const provider: "all" | "claude-code" | "codex" =
        providerParam === "claude-code" || providerParam === "codex" ? providerParam : "all";

      try {
        const result = await opts.analyze(range, provider);
        const rootStatus = {
          "claude-code": fs.existsSync(defaultClaudeRoot()),
          codex: fs.existsSync(defaultCodexRoot()),
        };
        const payload = {
          // i18n + locale + type + requestId are added by the bridge shim
          // before this is dispatched to the webview. Keep this body in
          // sync with what extension.ts/postData() emits otherwise.
          range,
          provider,
          result,
          rootExists: rootStatus["claude-code"] || rootStatus.codex,
          rootStatus,
          pricingMeta: buildPricingMeta(opts),
        };
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(payload));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: err?.message || String(err) }));
      }
      return;
    }

    if (url === "/favicon.ico") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "image/png");
      res.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          "base64",
        ),
      );
      return;
    }

    res.statusCode = 404;
    res.end("Not found.");
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      try {
        res.statusCode = 500;
        res.end(`Server error: ${err?.message || String(err)}`);
      } catch {
        /* response already sent */
      }
    });
  });

  const port = await listen(server);
  const addr = server.address() as AddressInfo;
  const boundPort = addr?.port ?? port;
  const url = `http://localhost:${boundPort}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        const closeAll = (server as unknown as { closeAllConnections?: () => void }).closeAllConnections;
        if (typeof closeAll === "function") closeAll.call(server);
      }),
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = PORT_START;

    const tryNext = () => {
      if (attempt > PORT_END) {
        reject(
          new Error(
            `no free port in range ${PORT_START}-${PORT_END}; pass --no-server to skip the dashboard`,
          ),
        );
        return;
      }
      const port = attempt++;
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          tryNext();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve(port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };

    tryNext();
  });
}
