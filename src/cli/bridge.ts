// Browser-side bridge that lets the unmodified VS Code webview
// (src/webview/main.js) run inside a plain browser served by the CLI's
// local HTTP dashboard. Stubs `acquireVsCodeApi()` and translates the
// existing `vscode.postMessage(...)` protocol into fetches against the
// `/api/data` endpoint.
//
// The shim is injected as inline JS BEFORE the webview's main.js, so
// `acquireVsCodeApi` is on `window` by the time main.js calls it.
//
// Server-side, two placeholders are substituted in this string:
//   __BURNRATE_I18N__         JSON map of locale → bundle
//   __BURNRATE_INITIAL_LANG__ Initial locale string

export const BRIDGE_JS = String.raw`
(function () {
  "use strict";
  var I18N_BUNDLES = __BURNRATE_I18N__;
  var INITIAL_LANG = __BURNRATE_INITIAL_LANG__;
  var STATE_KEY = "burnrate.cli.state";
  var LANG_KEY = "burnrate.cli.lang";

  function safeGetState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function safeSetState(s) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function detectInitialLocale() {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved === "en" || saved === "zh-cn") return saved;
    } catch (e) {}
    return INITIAL_LANG === "zh-cn" ? "zh-cn" : "en";
  }

  var currentLocale = detectInitialLocale();

  // Stale-response guard. The webview already de-dupes by requestId on
  // its own side, but we set the field here so the contract is intact.
  var inflight = 0;

  function postToWebview(payload) {
    window.dispatchEvent(new MessageEvent("message", { data: payload }));
  }

  function fetchData(range, provider) {
    var myReq = ++inflight;
    var url = "/api/data?range=" + encodeURIComponent(range) +
              "&provider=" + encodeURIComponent(provider);
    return fetch(url, { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        if (myReq !== inflight) return; // stale
        json.type = "data";
        json.requestId = myReq;
        json.range = range;
        json.provider = provider;
        json.i18n = I18N_BUNDLES[currentLocale] || I18N_BUNDLES.en;
        json.locale = currentLocale;
        postToWebview(json);
      })
      .catch(function (err) {
        if (myReq !== inflight) return;
        postToWebview({
          type: "error",
          requestId: myReq,
          message: (err && err.message) ? err.message : String(err),
        });
      });
  }

  function pushLocale(locale) {
    currentLocale = locale;
    try { localStorage.setItem(LANG_KEY, locale); } catch (e) {}
    // Ask the webview to re-render chrome with the new bundle but keep the
    // last data — exactly the message shape the extension uses on locale
    // change events.
    postToWebview({
      type: "i18n",
      bundle: I18N_BUNDLES[locale] || I18N_BUNDLES.en,
      locale: locale,
    });
  }

  // Swap the toolbar's "Refresh" pill for a Refresh + Language switch
  // group. We do it via DOMContentLoaded so the webview has time to
  // render its initial chrome from main.js, but before any user click.
  function injectLanguageSwitch() {
    var toolbar = document.querySelector(".toolbar");
    if (!toolbar) return;
    if (toolbar.querySelector("[data-burnrate-cli-lang]")) return;
    var group = document.createElement("div");
    group.className = "toolbar-group burnrate-cli-lang-group";
    group.setAttribute("data-burnrate-cli-lang", "");
    group.innerHTML =
      '<button class="pill" type="button" data-cli-lang="en">EN</button>' +
      '<button class="pill" type="button" data-cli-lang="zh-cn">中文</button>';
    var spacer = toolbar.querySelector(".spacer");
    if (spacer) toolbar.insertBefore(group, spacer);
    else toolbar.appendChild(group);
    paintLangPills();
    group.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var lang = t.getAttribute("data-cli-lang");
      if (!lang) return;
      pushLocale(lang);
      paintLangPills();
    });
  }

  function paintLangPills() {
    var pills = document.querySelectorAll("[data-cli-lang]");
    for (var i = 0; i < pills.length; i++) {
      var on = pills[i].getAttribute("data-cli-lang") === currentLocale;
      pills[i].classList.toggle("active", on);
    }
  }

  // The vscode API stub. main.js calls acquireVsCodeApi() exactly once at
  // module top; everything routes through the returned object.
  window.acquireVsCodeApi = function () {
    return {
      getState: safeGetState,
      setState: safeSetState,
      postMessage: function (msg) {
        if (!msg || typeof msg.type !== "string") return;
        switch (msg.type) {
          case "ready":
          case "setProvider":
          case "setRange": {
            var s = safeGetState();
            if (msg.range) s.range = msg.range;
            if (msg.provider) s.provider = msg.provider;
            safeSetState(s);
            var range = msg.range || s.range || "month";
            var provider = msg.provider || s.provider || "all";
            return fetchData(range, provider);
          }
          case "openSettings": {
            // Settings live in the VS Code extension. We tell the user
            // how to configure pricing in CLI mode without dragging
            // them to a 404.
            window.alert(
              currentLocale === "zh-cn"
                ? "设置仅在 VS Code 扩展中可用。CLI 模式请使用 --pricing <file> 加载自定义定价。"
                : "Settings live in the VS Code extension. For the CLI, pass --pricing <file> with your customPricing overrides."
            );
            return;
          }
          case "ignoreModel":
            // The CLI has no persistent settings store; silently no-op.
            return;
        }
      },
    };
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectLanguageSwitch);
  } else {
    injectLanguageSwitch();
  }
})();
`;
