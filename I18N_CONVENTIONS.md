# BurnRate i18n Conventions

> Read this before adding or translating any user-facing string. The
> scaffold is in place; this doc tells you the rules so the second pass
> (mass extraction + translation) lands consistently.

## TL;DR

- **Key = English source string, verbatim.** Don't invent dotted IDs.
- **Two runtime bundles**, same key set:
  - `l10n/bundle.l10n.en.json` — English (identity values)
  - `l10n/bundle.l10n.zh-cn.json` — 简体中文
- **Two manifest bundles**, same key set:
  - `package.nls.json` — English defaults
  - `package.nls.zh-cn.json` — Chinese
- Manifest strings (commands, settings) reference keys via `%key%` in
  `package.json`. Runtime strings call `i18n.t("English source")` in
  TS / `t("English source")` in webview JS.
- Missing key → falls back to the key (= English). Safe by design.

## Where translations live

| Layer | File(s) | Loaded by | Resolved via |
|---|---|---|---|
| Manifest (commands, setting labels/descriptions, enumDescriptions) | `package.nls.json`, `package.nls.zh-cn.json` | VS Code at install/load | `%key%` in `package.json` |
| Extension host (TS) | `l10n/bundle.l10n.<locale>.json` | `src/i18n.ts` `init()` | `i18n.t("…")` |
| Webview (HTML) | same JSON, pushed in `data` payload | `src/extension.ts` → `postMessage` | `data-i18n="…"` attribute |
| Webview (JS render) | same JSON, on `state.i18n` | `t()` helper in `main.js` | `t("…")` / `tn(one, other, n)` |

Manifest reload requires a VS Code restart. Runtime bundles update
**live** via the `i18n` postMessage when the user toggles
`burnRate.language`.

## Locale resolution

Implemented in `src/i18n.ts#resolveLocale`:

1. `burnRate.language` setting: `"en"` | `"zh-cn"` (also accepts
   `"zh-hans"` / `"zh"` as aliases) → use it.
2. `"auto"` (default): inspect `vscode.env.language`.
   - Anything starting with `zh` → `zh-cn`
   - Otherwise → `en`

Two locales only. Adding a third (e.g. `ja`) means: add to
`SUPPORTED_LOCALES`, ship `bundle.l10n.ja.json` + `package.nls.ja.json`,
extend `resolveLocale`, add the enum value in `package.json`.

## Key naming

- **The key IS the source English string.** Matches the `@vscode/l10n`
  default convention; lets greppability survive refactors.
- Keep punctuation, case, and trailing colons identical. `"Total Spend"`
  ≠ `"Total Spend:"` ≠ `"total spend"`.
- For sentences with variables, **place the variables, don't break the
  sentence**:
  - ✅ `"Cache reuse: {0}%"` → `"缓存复用：{0}%"`
  - ❌ `"Cache reuse: " + value + "%"` (un-translatable; word order
    differs across languages)

## Placeholders

Positional only: `{0}`, `{1}`, …

```ts
i18n.t("Cache reuse: {0}%", "12.4");
// → "Cache reuse: 12.4%"  (en)
// → "缓存复用：12.4%"     (zh-cn)
```

```js
t("Cache reuse: {0}%", "12.4");
```

- Numbers/strings only. Format numbers (`toFixed`, locale-aware) at the
  call site; the i18n layer doesn't.
- Don't use named placeholders, ICU, or `{}`-only — the runtime
  templater only understands `{N}`.

## Singular / plural

Chinese has no morphological plural, but English does. Use `tn`:

```ts
i18n.tn("{0} session", "{0} sessions", count, String(count));
```

```js
tn("{0} session", "{0} sessions", count, String(count));
```

Both keys ship in both bundles. In `zh-cn.json` they map to the same
string (`"{0} 个会话"`). Don't try to be clever with `count === 1`
inline — `tn` is the contract.

## HTML static text

For text that exists in `index.html` before any render runs (h1,
toolbar pills, subtitle), tag the element:

```html
<button class="pill provider-pill" data-provider="codex" data-i18n="Codex">Codex</button>
```

The English string in the element body is the **fallback** — it's
what users see if the bundle hasn't arrived yet. `applyStaticI18n()`
runs at boot and again whenever `state.i18n` updates.

Don't use `data-i18n` for dynamic text built inside `render()` — call
`t()` directly there.

## Worked examples (already in the repo)

| Pattern | File | Look for |
|---|---|---|
| TS extension-host translation | `src/extension.ts` | `i18n.t("Open Settings")` in the deprecation toast |
| Webview render-time translation | `src/webview/main.js` | `t("Total Spend")` / `t("Implied API Spend")` |
| Static HTML text | `src/webview/index.html` | `data-i18n="All Tools"` etc. on the toolbar |
| Manifest %key% | `package.json` | `"title": "%command.showDashboard.title%"` |

Use these as templates. Anything new should follow the same shape.

## What NOT to translate

- Model identifiers: `claude-sonnet-4-5`, `gpt-5`, `o3-mini`, …
- File paths and project directory names.
- JSON field names exposed in payloads (`requestId`, `provider`, …).
- Numeric formats (always emit numbers via `toFixed` /
  `toLocaleString` at the call site, then interpolate).
- Brand: **BurnRate** stays "BurnRate" in zh-cn too. "Claude Code" and
  "Codex" are product names — leave them.
- The `_comment` key in the JSON bundles is metadata, not a translation
  target. Leave it as-is in each file.

## Translation tone (zh-cn)

- 中性、简洁、技术化。避免口语化（不用 "啦/呀/呢"）。
- 标点：句中用全角中文符号（`：` `，` `。`），但 `{0}%` 这种紧贴占位符的
  地方按英文风格保留半角。
- 数字 / 货币 / 百分号：保持英文阿拉伯数字 + `$` / `%`，不要本地化为
  "美元" / "百分之"。
- 命令 / 设置项标题以 `BurnRate：` 前缀开头（中文冒号），与命令面板
  其他扩展保持一致。
- 短动词优先：`Refresh` → `刷新`；`Open Settings` → `打开设置`，不
  翻译为 `打开设置面板` 等冗长形式。

## Adding a new translatable string

1. Pick the English source string. That's your key.
2. Add the key to **both** `bundle.l10n.en.json` and
   `bundle.l10n.zh-cn.json` (manifest strings: both `package.nls*.json`
   files).
3. Replace the call site with `i18n.t(...)` / `t(...)` /
   `data-i18n="..."` / `%key%`.
4. Sanity check: the call still compiles, and switching
   `burnRate.language` between `en` / `zh-cn` flips the rendered text
   without restart (runtime layers) or after restart (manifest layer).

## Phase 2 handoff (for the bulk-extraction pass)

The remaining work is mechanical:

1. Walk every user-facing English string literal in:
   - `src/extension.ts`
   - `src/webview/main.js`
   - `src/webview/index.html`
   - `package.json` (any human-readable `description` / `title` /
     `enumDescription` / `markdownDescription` not yet `%key%`-fied)
2. Skip strings under "What NOT to translate" above.
3. For each, add the key to both runtime bundles (or both NLS files),
   then convert the call site using the worked example for that layer.
4. Compile (`npm run compile`) — must stay green.
5. Manual smoke check: open the dashboard with
   `burnRate.language: "zh-cn"`, switch all three range pills, all
   three provider pills. No leaked English in chrome / cards / empty
   states / errors / hover.

When in doubt about tone, terminology, or whether a string is even
user-facing, leave a `// i18n?` comment and surface it for review
rather than guessing.
