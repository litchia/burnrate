#!/usr/bin/env node
// Assembles the burnrate-cli npm package from the compiled out/ tree at
// the repo root. Runs as `prepublishOnly` so `npm publish` always ships
// fresh, version-synced output.
//
// What it does:
//   1. Copies the CLI entry + the analyzer/pricing/adapter modules from
//      ../out into ./dist (so the published package is self-contained).
//   2. Syncs version from the root package.json into ./package.json
//      (single source of truth for "what version is BurnRate at").
//   3. Ensures the CLI entry has a shebang and is executable.
//   4. Copies LICENSE from the root.

const fs = require("fs");
const path = require("path");

const here = __dirname;
const root = path.resolve(here, "..");
const out = path.join(root, "out");
const dist = path.join(here, "dist");

if (!fs.existsSync(out)) {
  console.error(
    `[burnrate-cli] compiled output not found at ${out}. Run \`npm run compile\` at the repo root first.`,
  );
  process.exit(1);
}

// 1. Sync version from the root package.json.
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const cliPkgPath = path.join(here, "package.json");
const cliPkg = JSON.parse(fs.readFileSync(cliPkgPath, "utf8"));
if (cliPkg.version !== rootPkg.version) {
  cliPkg.version = rootPkg.version;
  fs.writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + "\n");
  console.log(`[burnrate-cli] synced version to ${rootPkg.version}`);
}

// 2. Wipe + recreate dist/.
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 3. Copy required modules.
const required = [
  "cli", // directory — the CLI itself
  "analyzer.js",
  "pricing.js",
  "providerAdapter.js",
  "claudeCodeAdapter.js",
  "codexAdapter.js",
];

const optional = [
  "cli", // d.ts and maps under it, handled by recursive copy
  "analyzer.js.map",
  "analyzer.d.ts",
  "pricing.js.map",
  "pricing.d.ts",
  "providerAdapter.js.map",
  "providerAdapter.d.ts",
  "claudeCodeAdapter.js.map",
  "claudeCodeAdapter.d.ts",
  "codexAdapter.js.map",
  "codexAdapter.d.ts",
];

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

for (const m of required) {
  const srcPath = path.join(out, m);
  if (!fs.existsSync(srcPath)) {
    console.error(`[burnrate-cli] missing required ${srcPath}`);
    process.exit(1);
  }
  copyRecursive(srcPath, path.join(dist, m));
}

for (const m of optional) {
  const srcPath = path.join(out, m);
  if (!fs.existsSync(srcPath)) continue;
  const dstPath = path.join(dist, m);
  if (!fs.existsSync(dstPath)) copyRecursive(srcPath, dstPath);
}

// 3b. Webview HTML/JS — required by the dashboard server. Copied from
// the repo's `src/webview/` (these files are not compiled, they ship
// as-is). Mirrors what the VS Code extension reads at runtime.
const webviewSrc = path.join(root, "src", "webview");
const webviewDst = path.join(dist, "webview");
fs.mkdirSync(webviewDst, { recursive: true });
for (const f of ["index.html", "main.js"]) {
  const s = path.join(webviewSrc, f);
  if (!fs.existsSync(s)) {
    console.error(`[burnrate-cli] missing webview asset ${s}`);
    process.exit(1);
  }
  fs.copyFileSync(s, path.join(webviewDst, f));
}

// 3c. l10n bundles — same source the VS Code extension uses, minus the
// `_comment` keys (server.ts strips those before sending to the browser).
const l10nSrc = path.join(root, "l10n");
const l10nDst = path.join(dist, "l10n");
fs.mkdirSync(l10nDst, { recursive: true });
for (const f of ["bundle.l10n.en.json", "bundle.l10n.zh-cn.json"]) {
  const s = path.join(l10nSrc, f);
  if (!fs.existsSync(s)) {
    console.error(`[burnrate-cli] missing l10n bundle ${s}`);
    process.exit(1);
  }
  fs.copyFileSync(s, path.join(l10nDst, f));
}

// 4. CLI entry: ensure shebang + executable.
const entry = path.join(dist, "cli", "index.js");
let entrySrc = fs.readFileSync(entry, "utf8");
if (!entrySrc.startsWith("#!")) {
  entrySrc = "#!/usr/bin/env node\n" + entrySrc;
  fs.writeFileSync(entry, entrySrc);
}
fs.chmodSync(entry, 0o755);

// 5. Mirror LICENSE.
fs.copyFileSync(path.join(root, "LICENSE"), path.join(here, "LICENSE"));

console.log("[burnrate-cli] dist/ ready, version", rootPkg.version);
