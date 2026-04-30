// Lightweight runtime i18n for BurnRate.
//
// VS Code's built-in `vscode.l10n.t()` follows `vscode.env.language` only — it
// can't honor a per-extension override. We want users on a Chinese IDE to be
// able to keep BurnRate in English (or vice versa) without restarting the
// editor, so we ship our own loader that:
//
//   - reads bundle JSON from /l10n/bundle.l10n.<locale>.json
//   - resolves the active locale from `burnRate.language`, falling back to
//     `vscode.env.language` when the setting is "auto"
//   - exposes `t()` for extension-host code and `getBundleForWebview()` so
//     the webview can render the same dict
//   - fires an event when the user flips the setting so the webview can be
//     refreshed in place (no reload required)
//
// Manifest strings (commands, settings) still go through VS Code's standard
// `package.nls.*` mechanism, which is bound to `vscode.env.language` and only
// updates on editor restart. That mismatch is documented in the language
// setting's description.

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export type Locale = "en" | "zh-cn";
export type Bundle = Record<string, string>;

const SUPPORTED_LOCALES: ReadonlyArray<Locale> = ["en", "zh-cn"];
const DEFAULT_LOCALE: Locale = "en";

let active: Locale = DEFAULT_LOCALE;
/** Webview-driven override (e.g. the EN / 中文 toggle in the dashboard). When
 *  set, wins over the `burnRate.language` setting until cleared with `null`. */
let override: Locale | null = null;
const bundles: Record<Locale, Bundle> = { en: {}, "zh-cn": {} };
const emitter = new vscode.EventEmitter<Locale>();

/** Fires whenever the active locale changes (setting flip or VS Code lang change). */
export const onDidChangeLocale = emitter.event;

export function init(context: vscode.ExtensionContext): vscode.Disposable {
  for (const locale of SUPPORTED_LOCALES) {
    bundles[locale] = loadBundle(context, `bundle.l10n.${locale}.json`);
  }
  recompute();
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration("burnRate.language")) return;
    const previous = active;
    recompute();
    if (active !== previous) emitter.fire(active);
  });
}

export function getActiveLocale(): Locale {
  return active;
}

/**
 * Override the active locale at runtime — used by the webview's EN / 中文
 * pill so users can flip language without touching the settings file.
 * Pass `null` to clear and fall back to the `burnRate.language` setting.
 */
export function setOverride(locale: string | null): void {
  if (locale === null) {
    override = null;
  } else if (locale === "en" || locale === "zh-cn") {
    override = locale;
  } else {
    return; // unknown locale string — ignore silently
  }
  const previous = active;
  recompute();
  if (active !== previous) emitter.fire(active);
}

/**
 * Translate a key. Keys ARE the English source string by convention (matches
 * @vscode/l10n's default keying). Positional placeholders use `{0}`, `{1}`, …
 *
 *   t("Total Spend")                       // "Total Spend" / "总消费"
 *   t("Cache reuse: {0}%", "12.4")         // "Cache reuse: 12.4%"
 *
 * Missing keys fall back to the key itself, so English source is always a
 * usable last resort even if the Chinese bundle drifts.
 */
export function t(key: string, ...args: Array<string | number>): string {
  const bundle = bundles[active];
  const template = bundle[key] ?? key;
  return formatTemplate(template, args);
}

/**
 * Singular / plural picker. English uses different keys; Chinese can map both
 * to the same translation (Chinese has no morphological plural).
 *
 *   tn("{0} session", "{0} sessions", count, count)
 */
export function tn(
  keyOne: string,
  keyOther: string,
  count: number,
  ...args: Array<string | number>
): string {
  return t(count === 1 ? keyOne : keyOther, ...args);
}

/**
 * The active bundle for posting to the webview. The webview's own `t()` uses
 * the same lookup-then-fallback semantics, so an empty/missing bundle still
 * renders correctly (in English source).
 */
export function getBundleForWebview(): Bundle {
  return bundles[active];
}

function loadBundle(context: vscode.ExtensionContext, fileName: string): Bundle {
  try {
    const full = path.join(context.extensionPath, "l10n", fileName);
    if (!fs.existsSync(full)) return {};
    const raw = fs.readFileSync(full, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Bundle = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function recompute(): void {
  if (override !== null) {
    active = override;
    return;
  }
  const setting = String(
    vscode.workspace.getConfiguration("burnRate").get("language", "auto"),
  ).toLowerCase();
  active = resolveLocale(setting);
}

function resolveLocale(setting: string): Locale {
  if (setting === "en") return "en";
  if (setting === "zh-cn" || setting === "zh-hans" || setting === "zh") return "zh-cn";
  // auto — follow VS Code display language
  const vscodeLang = String(vscode.env.language || "en").toLowerCase();
  if (vscodeLang.startsWith("zh")) return "zh-cn";
  return "en";
}

function formatTemplate(template: string, args: Array<string | number>): string {
  return template.replace(/\{(\d+)\}/g, (match, idxStr) => {
    const idx = Number(idxStr);
    if (Number.isInteger(idx) && idx >= 0 && idx < args.length) {
      return String(args[idx]);
    }
    return match;
  });
}
