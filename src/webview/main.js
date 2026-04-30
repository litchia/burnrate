/* BurnRate webview renderer.
 *
 * Receives `{ type: "data", result, range, provider, pricingMeta, i18n,
 * locale, ... }` messages from the extension host (or, in CLI mode, from
 * the bridge in src/cli/bridge.ts which fakes the `acquireVsCodeApi`
 * surface). Posts back `setRange` / `setProvider` / `setLocale` /
 * `ready` / `openSettings` / `ignoreModel` for the host to act on.
 *
 * Architecture: a single render() pulls from `state` and rebuilds the
 * #app subtree from template strings. Event delegation on #app handles
 * all clicks. No framework; we run in a CSP-locked webview, so plain JS
 * keeps the dependency surface zero.
 */
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("app");
  const persisted = vscode.getState() || {};

  const VALID_RANGES = ["today", "week", "month", "all"];
  const VALID_PROVIDERS = ["all", "claude-code", "codex"];
  const VALID_THEMES = ["auto", "light", "dark"];

  /**
   * The full client-side state tree. Anything that affects rendering
   * lives here; render() is a pure function of `state` plus i18n.
   */
  const state = {
    /** Last successful payload from the extension. Null until first response. */
    payload: null,
    /** Local error to display in lieu of `payload`. */
    error: null,
    /** Filter pills. `range` mirrors the host-side range so reloads stay in sync. */
    range: VALID_RANGES.includes(persisted.range) ? persisted.range : "month",
    provider: VALID_PROVIDERS.includes(persisted.provider) ? persisted.provider : "all",
    /** Heatmap axis: "spend" or "tokens". Local-only; host doesn't care. */
    dataKind: persisted.dataKind === "tokens" ? "tokens" : "spend",
    /** Theme picker. "auto" = follow VS Code body class / system pref;
     *  "light" / "dark" = explicit user override. Stored in vscode.setState
     *  so the choice survives panel reloads. */
    theme: VALID_THEMES.includes(persisted.theme) ? persisted.theme : "auto",
    /** YYYY-MM-DD of the heatmap cell currently under the cursor (null = today). */
    hoveredDay: null,
    /** Path of the project row currently expanded; null when none open. */
    expandedProjectPath: null,
    /** Last seen requestId — drop stale responses. */
    lastRequestId: 0,
    /** i18n bundle and active locale. Filled by the host on first message. */
    i18n: {},
    locale: "en",
  };

  /* ------------------------------------------------------------------
   * i18n
   * Same convention as the original webview: keys ARE the English source
   * string (matches @vscode/l10n). Missing keys fall back to the key.
   * Positional placeholders use {0}, {1}, …
   * ------------------------------------------------------------------ */
  function t(key, ...args) {
    const tpl = (state.i18n && state.i18n[key]) || key;
    return args.length
      ? tpl.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""))
      : tpl;
  }

  /* ------------------------------------------------------------------
   * Formatters
   * Money: 2 decimals, dollar prefix.
   * Tokens: <1k raw, <1M as k, ≥1M as M.
   * Dates: ISO YYYY-MM-DD already from the analyzer; we display as-is.
   * ------------------------------------------------------------------ */
  function fmtUsd(n) {
    if (!isFinite(n)) return "$0.00";
    return "$" + Math.max(0, n).toFixed(2);
  }
  function fmtTokens(n) {
    if (!isFinite(n) || n <= 0) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(Math.round(n));
  }
  function fmtPct(p, digits = 1) {
    if (!isFinite(p)) return "0%";
    return p.toFixed(digits) + "%";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
    );
  }

  /**
   * Resolve `state.theme` ("auto"|"light"|"dark") to one of just
   * "light" / "dark" — the concrete CSS branch that should be in
   * effect right now. We snapshot VS Code's body class and the
   * `prefers-color-scheme` media query at every render so toggling
   * the OS / VS Code theme while the dashboard is open updates the
   * surface palette immediately.
   */
  function resolveTheme() {
    if (state.theme === "light" || state.theme === "dark") return state.theme;
    const cls = document.body.classList;
    if (cls.contains("vscode-light")) return "light";
    if (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast")) return "dark";
    if (typeof window.matchMedia === "function") {
      try {
        if (window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
      } catch { /* ignore — older browsers without matchMedia */ }
    }
    return "dark";
  }

  /* ------------------------------------------------------------------
   * Snapshot derivation
   * The analyzer hands us `AnalysisResult`. The dashboard wants a flat
   * burn-rate snapshot (spec'd in DATA_CONTRACT.md). We translate here.
   * Any field the analyzer can't compute (modelSwitches, monthly budget)
   * is either stubbed or sourced from the user's settings via pricingMeta.
   * ------------------------------------------------------------------ */
  function deriveSnapshot(payload) {
    const r = payload.result || {};
    const range = payload.range || state.range;
    const totals = r.totals || {};

    const totalSpend = totals.cost || 0;
    const totalTokens =
      (totals.inTokens || 0) +
      (totals.outTokens || 0) +
      (totals.cacheRead || 0) +
      (totals.cacheWrite || 0);
    const cacheReadable = (totals.inTokens || 0) + (totals.cacheRead || 0);
    const cacheHit = cacheReadable > 0 ? (totals.cacheRead || 0) / cacheReadable : 0;

    const claude = (r.byProvider && r.byProvider["claude-code"]) || { cost: 0, tokens: 0, messages: 0 };
    const codex = (r.byProvider && r.byProvider["codex"]) || { cost: 0, tokens: 0, messages: 0 };

    // Daily series. byDay is { "YYYY-MM-DD": cost }; byDayProviders has
    // per-provider cost per day. We zip them by date and produce a sorted
    // ascending series capped at 30 entries — the sparkline / heatmap
    // need a recent window.
    const byDay = r.byDay || {};
    const byDayProv = r.byDayProviders || {};
    const dailyAll = Object.keys(byDay)
      .sort()
      .map((d) => {
        const p = byDayProv[d] || {};
        return {
          d,
          v: byDay[d] || 0,
          claude: (p["claude-code"] && p["claude-code"].cost) || 0,
          codex: (p["codex"] && p["codex"].cost) || 0,
        };
      });

    // Up to 30 most recent daily points for the sparkline & heatmap.
    const daily = dailyAll.slice(-30);

    // Burn rate: $/day, last 30 days; delta vs the 30 days prior.
    const tail30 = dailyAll.slice(-30).reduce((a, b) => a + (b.v || 0), 0);
    const burnRate = tail30 / 30;
    const prior30 = dailyAll.slice(-60, -30).reduce((a, b) => a + (b.v || 0), 0);
    const prevBurnRate = prior30 / 30;
    const burnDelta = prevBurnRate > 0 ? (burnRate - prevBurnRate) / prevBurnRate : 0;
    const burnDeltaDir = burnDelta < 0 ? "down" : "up";

    // Days active across the daily series.
    const daysActive = dailyAll.filter((d) => d.v > 0).length;
    const today = new Date();
    const daysInThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const daysTotal =
      range === "today" ? 1
      : range === "week" ? 7
      : range === "month" ? daysInThisMonth
      : Math.max(daysActive, dailyAll.length || 0);

    const budget = (payload.pricingMeta && payload.pricingMeta.monthlyBudget) || 0;
    const projectedMonthEnd = burnRate * daysInThisMonth;

    // Top project: highest cost.
    const projectsRaw = Object.values(r.byProject || {});
    const sortedProjects = [...projectsRaw].sort((a, b) => (b.cost || 0) - (a.cost || 0));
    const topProjectRaw = sortedProjects[0];
    const topProject = topProjectRaw
      ? {
          path: shortenPath(topProjectRaw.project || ""),
          rawPath: topProjectRaw.project || "",
          spend: topProjectRaw.cost || 0,
          sessions: typeof topProjectRaw.sessions === "number" ? topProjectRaw.sessions : 0,
          claudeShare: providerShare(topProjectRaw, "claude-code"),
          codexShare: providerShare(topProjectRaw, "codex"),
        }
      : null;

    // Projects (filtered + ordered).
    const projects = sortedProjects
      .map((p) => {
        const claudeShare = providerShare(p, "claude-code");
        const codexShare = providerShare(p, "codex");
        const tokens =
          (p.inTokens || 0) + (p.outTokens || 0) + (p.cacheRead || 0) + (p.cacheWrite || 0);
        const sessions = typeof p.sessions === "number" ? p.sessions : 0;
        const hasFlame = (p.cost || 0) >= 25; // simple "hot" threshold for the design
        return {
          path: shortenPath(p.project || ""),
          rawPath: p.project || "",
          spend: p.cost || 0,
          tokens,
          sessions,
          claude: claudeShare,
          codex: codexShare,
          hasFlame,
        };
      })
      .filter((p) => {
        if (state.provider === "all") return true;
        if (state.provider === "claude-code") return p.claude > 0;
        if (state.provider === "codex") return p.codex > 0;
        return true;
      });

    // Models — already aggregated; sort by spend desc, then tokens desc
    // so unpriced models still surface in a stable order.
    const modelsRaw = Object.entries(r.byModel || {});
    const allShareDenom = modelsRaw.reduce((a, [, m]) => a + (m.cost || 0), 0);
    const models = modelsRaw
      .map(([name, m]) => {
        const tool = inferTool(m, name);
        return {
          name,
          tool, // "Claude" or "Codex" — design's casing
          spend: m.cost || 0,
          tokens: m.tokens || 0,
          calls: m.messages || 0,
          share: allShareDenom > 0 ? (m.cost || 0) / allShareDenom : 0,
          free: !m.isKnown && (m.cost || 0) === 0,
        };
      })
      .filter((m) => {
        if (state.provider === "all") return true;
        if (state.provider === "claude-code") return m.tool === "Claude";
        if (state.provider === "codex") return m.tool === "Codex";
        return true;
      })
      .sort((a, b) => (b.spend || 0) - (a.spend || 0) || (b.tokens || 0) - (a.tokens || 0));

    // Spike turns ("top burns batches" in the design).
    const spikes = r.spikes || [];
    const batches = spikes
      .filter((s) => {
        if (state.provider === "all") return true;
        return s.provider === state.provider;
      })
      .map((s) => ({
        amt: s.cost || 0,
        tok: fmtTokens(s.tokens || 0),
        rawTokens: s.tokens || 0,
        path: shortenPath(s.project || ""),
        rawPath: s.project || "",
        model: s.model || "",
        when: s.ts || "",
        isKnown: s.isKnown !== false,
      }));

    return {
      // Top-level totals
      totalSpend,
      totalTokens,
      cacheHit,
      sessions: totals.sessions || 0,
      messages: totals.messages || 0,
      syntheticMessages: totals.syntheticMessages || 0,
      unknownMessages: totals.unknownMessages || 0,
      modelSwitches: 0, // not tracked by the analyzer; design tolerates 0

      byTool: {
        claude: { spend: claude.cost || 0, tokens: claude.tokens || 0 },
        codex: { spend: codex.cost || 0, tokens: codex.tokens || 0 },
      },

      topProject,

      // Burn-rate
      burnRate,
      burnDelta,
      burnDeltaDir,
      daysActive,
      daysTotal,
      budget,
      projectedMonthEnd,

      // Series + collections
      daily,
      projects,
      models,
      batches,

      // Range / provider passthrough for header copy.
      range,
      rangeISO: range,

      // Pricing-pending bucket: synthetic Claude turns are excluded from
      // spend by design; surface their count as the "locked / awaiting
      // pricing" indicator the design calls for.
      locked: {
        count: totals.syntheticMessages || 0,
        approxTokens: 0,
      },
    };
  }

  /** Provider share of a project's spend (0..1). */
  function providerShare(project, providerId) {
    const total = project.cost || 0;
    if (total <= 0) return 0;
    const p = project.providers && project.providers[providerId];
    if (!p) return 0;
    return Math.max(0, Math.min(1, (p.cost || 0) / total));
  }

  /** Best-effort "is this a Claude or Codex model?" — prefer the
   *  analyzer's per-model providers map, fall back to a name prefix. */
  function inferTool(modelStat, name) {
    const provs = modelStat.providers || {};
    const claudeCost = (provs["claude-code"] && provs["claude-code"].cost) || 0;
    const codexCost = (provs["codex"] && provs["codex"].cost) || 0;
    if (claudeCost > codexCost) return "Claude";
    if (codexCost > claudeCost) return "Codex";
    if (typeof name === "string") {
      if (/^claude/i.test(name)) return "Claude";
      if (/^(gpt|o\d|codex)/i.test(name)) return "Codex";
    }
    return "Claude";
  }

  /** Trim long absolute paths to the design's "..../tail/segment" form. */
  function shortenPath(p) {
    if (!p) return "";
    const segs = p.split(/[\\/]/).filter(Boolean);
    if (segs.length <= 3) return p;
    return ".../" + segs.slice(-3).join("/");
  }

  /* ------------------------------------------------------------------
   * Component renderers — each returns an HTML string.
   * Functions take the snapshot (and i18n is a closure over `t`).
   * ------------------------------------------------------------------ */

  /** SVG flame, used in the burn-rate label and "hot" tags. */
  function fireIconSvg(size = 14) {
    const id = `fg-${size}-${Math.random().toString(36).slice(2, 7)}`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--fire-1)"/>
          <stop offset="1" stop-color="var(--fire-3)"/>
        </linearGradient>
      </defs>
      <path d="M8 1.5c0 2.5 -3 3.2 -3 6.5a3 3 0 0 0 6 0c0 -1.5 -1 -2 -1 -3.5 0 -1.2 -1 -2 -2 -3z" fill="url(#${id})"/>
    </svg>`;
  }

  function renderTopbar(snap, syncedAt, totalSessions) {
    const langSeg = `<div class="lang-seg">
      <button class="${state.locale !== "zh-cn" ? "active" : ""}" data-lang="en">EN</button>
      <button class="${state.locale === "zh-cn" ? "active" : ""}" data-lang="zh-cn">中文</button>
    </div>`;
    const themeSeg = `<div class="lang-seg theme-seg" role="group" aria-label="${escapeHtml(t("Theme"))}">
      <button class="${state.theme === "auto" ? "active" : ""}" data-theme-pick="auto" title="${escapeHtml(t("Follow system theme"))}">${escapeHtml(t("Auto"))}</button>
      <button class="${state.theme === "light" ? "active" : ""}" data-theme-pick="light" title="${escapeHtml(t("Light theme"))}">${escapeHtml(t("Light"))}</button>
      <button class="${state.theme === "dark" ? "active" : ""}" data-theme-pick="dark" title="${escapeHtml(t("Dark theme"))}">${escapeHtml(t("Dark"))}</button>
    </div>`;
    return `<div class="topbar">
      <div class="brand">
        <div class="brand-mark"></div>
        <div>
          <div class="brand-name">BurnRate</div>
          <div class="brand-sub">${escapeHtml(t("Claude Code · Codex CLI"))}</div>
        </div>
      </div>
      <div class="toprow-r">
        <span class="synced-dot" aria-hidden="true"></span>
        <span>${escapeHtml(t("{0} sessions synced · last update {1}", String(totalSessions), syncedAt))}</span>
        <button type="button" class="refresh" data-action="refresh">${escapeHtml(t("Refresh"))}</button>
        ${themeSeg}
        ${langSeg}
      </div>
    </div>`;
  }

  function renderFilterBar(snap) {
    const tool = state.provider;
    const range = state.range;
    const lockedDesc =
      snap.locked.count > 0
        ? t("{0} sessions · awaiting pricing", String(snap.locked.count))
        : "";
    const noticeStrip =
      snap.locked.count > 0
        ? `<div class="notice">${escapeHtml(t("These sessions are queued — pricing data not yet available."))}</div>`
        : "";
    return `<div>
      <div class="filterbar">
        <div class="seg" role="group" aria-label="tool">
          <button class="${tool === "all" ? "active" : ""}" data-tool="all">${escapeHtml(t("All tools"))}</button>
          <button class="${tool === "claude-code" ? "active" : ""}" data-tool="claude-code">${escapeHtml(t("Claude Code"))}</button>
          <button class="${tool === "codex" ? "active" : ""}" data-tool="codex">${escapeHtml(t("Codex"))}</button>
        </div>
        <div class="seg" role="group" aria-label="range">
          <button class="${range === "today" ? "active" : ""}" data-range="today">${escapeHtml(t("Today"))}</button>
          <button class="${range === "week" ? "active" : ""}" data-range="week">${escapeHtml(t("Week"))}</button>
          <button class="fire ${range === "month" ? "active" : ""}" data-range="month">${escapeHtml(t("Month"))}</button>
          <button class="${range === "all" ? "active" : ""}" data-range="all">${escapeHtml(t("All time"))}</button>
        </div>
        ${lockedDesc ? `<span class="filter-meta">${escapeHtml(lockedDesc)}</span>` : ""}
      </div>
      ${noticeStrip}
    </div>`;
  }

  /**
   * Sparkline. 30-point series, area + line + spike dots. SVG is sized
   * by viewBox so the parent container stretches it naturally.
   */
  function renderSparkline(daily) {
    const W = 600, H = 86, PAD = 4;
    if (!daily.length) return `<svg viewBox="0 0 ${W} ${H}"></svg>`;
    const vals = daily.map((d) => d.v);
    const max = Math.max(1, ...vals);
    const step = daily.length === 1 ? 0 : (W - PAD * 2) / (daily.length - 1);
    const points = daily.map((d, i) => {
      const x = PAD + i * step;
      const y = H - PAD - (d.v / max) * (H - PAD * 2);
      return [x, y];
    });
    const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
    const areaPath =
      linePath +
      ` L${points[points.length - 1][0]},${H - PAD} L${points[0][0]},${H - PAD} Z`;
    const grids = [0.25, 0.5, 0.75]
      .map((g) => {
        const y = PAD + g * (H - PAD * 2);
        return `<line x1="${PAD}" x2="${W - PAD}" y1="${y}" y2="${y}" stroke="var(--line-soft)" stroke-dasharray="2 4" stroke-width="1"/>`;
      })
      .join("");
    const dots = points
      .map(([x, y], i) =>
        daily[i].v > Math.max(30, max * 0.7)
          ? `<circle cx="${x}" cy="${y}" r="2.5" fill="var(--fire-1)" stroke="var(--bg-elev)" stroke-width="1.5"/>`
          : "",
      )
      .join("");
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="sparkArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--fire-2)" stop-opacity="0.5"/>
          <stop offset="1" stop-color="var(--fire-2)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="sparkLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="var(--fire-1)"/>
          <stop offset="1" stop-color="var(--fire-3)"/>
        </linearGradient>
      </defs>
      ${grids}
      <path d="${areaPath}" fill="url(#sparkArea)"/>
      <path d="${linePath}" fill="none" stroke="url(#sparkLine)" stroke-width="1.5" stroke-linejoin="round"/>
      ${dots}
    </svg>`;
  }

  function renderBurnHero(snap) {
    const deltaDir = snap.burnDeltaDir;
    const deltaMagnitude = Math.abs(snap.burnDelta * 100).toFixed(0);
    const deltaArrow = deltaDir === "down" ? "↓" : "↑";
    const budget = snap.budget || 0;
    const usedPct = budget > 0 ? Math.min(100, (snap.totalSpend / budget) * 100) : 0;
    const projPct = budget > 0 ? Math.min(100, (snap.projectedMonthEnd / budget) * 100) : 0;
    const topClaudePct = Math.round((snap.topProject?.claudeShare || 0) * 100);
    const topCodexPct = Math.round((snap.topProject?.codexShare || 0) * 100);

    const burnSubText = t(
      "{0} / {1} active days · {2}-day rolling avg",
      String(snap.daysActive),
      String(snap.daysTotal),
      "30",
    );

    const budgetCard = budget > 0
      ? `<div class="burn-side">
          <div class="burn-label"><span>${escapeHtml(t("Monthly budget"))}</span></div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px;">
            <span class="mono" style="font-size:22px;font-weight:600;">${escapeHtml(fmtUsd(snap.totalSpend))}</span>
            <span class="mono mute" style="font-size:12px;">/ ${escapeHtml(fmtUsd(budget))}</span>
          </div>
          <div class="budget-bar">
            <div class="budget-fill" style="width:${usedPct}%"></div>
            <div class="budget-marker" style="left:${projPct}%" title="${escapeHtml(t("Projected"))}"></div>
          </div>
          <div class="budget-meta">
            <span>${escapeHtml(fmtPct(usedPct, 1))} ${escapeHtml(t("of"))}</span>
            <span>~ ${escapeHtml(fmtUsd(snap.projectedMonthEnd))} ${escapeHtml(t("Projected"))}</span>
          </div>
        </div>`
      : `<div class="burn-side">
          <div class="burn-label"><span>${escapeHtml(t("Monthly budget"))}</span></div>
          <div class="mono mute" style="font-size:12px;margin-top:10px;line-height:1.6;">
            ${escapeHtml(t("Set burnRate.monthlyBudget in settings to track pacing."))}
          </div>
        </div>`;

    const topProjectCard = snap.topProject
      ? `<div class="burn-side">
          <div class="burn-label"><span>${escapeHtml(t("Top project"))}</span></div>
          <div class="mono" title="${escapeHtml(snap.topProject.rawPath)}" style="font-size:14px;margin-top:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(snap.topProject.path)}</div>
          <div class="mono mute" style="font-size:12px;margin-top:6px;">${escapeHtml(fmtUsd(snap.topProject.spend))} · ${snap.topProject.sessions} ${escapeHtml(t("sessions"))}</div>
          <div class="top-project-bar">
            ${topClaudePct > 0 ? `<i class="claude" style="width:${topClaudePct}%"></i>` : ""}
            ${topCodexPct > 0 ? `<i class="codex" style="width:${topCodexPct}%"></i>` : ""}
          </div>
        </div>`
      : "";

    return `<div class="burnhero">
      <div class="burn-main">
        <div class="burn-label">
          <span class="fire-icon">${fireIconSvg(12)}</span>
          <span>${escapeHtml(t("Burn rate"))}</span>
        </div>
        <div class="burn-rate">
          <span class="v">${escapeHtml(fmtUsd(snap.burnRate))}</span>
          <span class="unit">${escapeHtml(t("/ day"))}</span>
          <span class="delta ${deltaDir === "down" ? "down" : ""}">${deltaArrow} ${deltaMagnitude}% ${escapeHtml(t("vs last week"))}</span>
        </div>
        <div class="burn-sub">${escapeHtml(burnSubText)}</div>
        <div class="burn-spark">${renderSparkline(snap.daily)}</div>
      </div>
      <div class="burn-side-grid">
        ${budgetCard}
        ${topProjectCard}
      </div>
    </div>`;
  }

  function renderStatStrip(snap) {
    const totalForShare = snap.byTool.claude.spend + snap.byTool.codex.spend;
    const claudeShare = totalForShare > 0 ? (snap.byTool.claude.spend / totalForShare) * 100 : 0;
    const codexShare = totalForShare > 0 ? (snap.byTool.codex.spend / totalForShare) * 100 : 0;
    const topProjTail = snap.topProject
      ? snap.topProject.path.split(/[\\/]/).slice(-2).join("/")
      : "—";

    return `<div class="stat-strip">
      <div class="stat">
        <div class="k">${escapeHtml(t("Total spend (month)"))}</div>
        <div class="v">${escapeHtml(fmtUsd(snap.totalSpend))}</div>
        <div class="sub">${escapeHtml(
          t("{0} prompts · {1} convos · {2} switches",
            String(snap.messages),
            String(snap.sessions),
            String(snap.modelSwitches),
          ),
        )}</div>
      </div>
      <div class="stat">
        <div class="k">${escapeHtml(t("Tokens"))}</div>
        <div class="v">${escapeHtml(fmtTokens(snap.totalTokens))}</div>
        <div class="sub">${escapeHtml(t("Cache hit"))}: ${escapeHtml(fmtPct(snap.cacheHit * 100, 1))}</div>
      </div>
      <div class="stat">
        <div class="k">${escapeHtml(t("By tool"))}</div>
        <div class="split" style="margin-top:12px;">
          <span><i class="dot claude"></i> Claude</span>
          <span><i class="dot codex"></i> Codex</span>
        </div>
        <div class="sub" style="margin-top:6px;">
          ${escapeHtml(fmtUsd(snap.byTool.claude.spend))} (${escapeHtml(fmtPct(claudeShare, 1))})<br/>
          ${escapeHtml(fmtUsd(snap.byTool.codex.spend))} (${escapeHtml(fmtPct(codexShare, 1))})
        </div>
      </div>
      <div class="stat">
        <div class="k">${escapeHtml(t("Top project"))}</div>
        <div class="v" style="font-size:15px;line-height:1.3;font-weight:500;">${escapeHtml(topProjTail)}</div>
        <div class="sub">${snap.topProject ? `${escapeHtml(fmtUsd(snap.topProject.spend))} · ${snap.topProject.sessions} ${escapeHtml(t("sessions"))}` : "—"}</div>
      </div>
    </div>`;
  }

  /**
   * Calendar heatmap. Cells are aligned to the day-of-week of the
   * earliest entry in the daily series — this honours the spec example
   * (April 1 2026 = Wednesday → 3 leading invisible cells) without
   * hard-coding April. Hover updates state.hoveredDay so the detail
   * panel re-renders.
   */
  function renderHeatmap(snap) {
    const days = snap.daily;
    if (!days.length) {
      return `<div class="heatmap-card"><div class="heatmap-detail mute mono" style="font-size:12px;">${escapeHtml(t("No usage data in this range. Try All Time."))}</div></div>`;
    }

    const max = Math.max(1, ...days.map((d) => d.v || 0));
    const colorFor = (v) => {
      if (!v) return "var(--bg-elev-2)";
      const r = v / max;
      if (r < 0.15) return "oklch(0.35 0.06 50)";
      if (r < 0.35) return "oklch(0.50 0.12 55)";
      if (r < 0.6)  return "oklch(0.62 0.16 50)";
      if (r < 0.85) return "oklch(0.72 0.18 45)";
      return "oklch(0.80 0.18 70)";
    };

    const todayKey = todayLocalKey();
    const firstDate = parseLocalDate(days[0].d);
    const startDow = firstDate ? firstDate.getDay() : 0;
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    days.forEach((d) => cells.push(d));
    while (cells.length % 7 !== 0) cells.push(null);

    const dowLabels = (state.locale === "zh-cn"
      ? ["日", "一", "二", "三", "四", "五", "六"]
      : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
      .map((x) => `<div class="dow">${escapeHtml(x)}</div>`)
      .join("");

    const cellHtml = cells
      .map((c) => {
        if (!c) return `<div class="heatcell empty"></div>`;
        const isToday = c.d === todayKey;
        const day = (c.d || "").slice(-2).replace(/^0/, "");
        return `<div class="heatcell ${isToday ? "today" : ""}"
            style="background:${colorFor(c.v)};${c.v ? "border-color:transparent;" : ""}"
            data-day="${escapeHtml(c.d)}"
            title="${escapeHtml(c.d)}  ${escapeHtml(fmtUsd(c.v))}">${escapeHtml(day)}</div>`;
      })
      .join("");

    // Detail panel: hovered day, falling back to today (or last data point).
    const focused =
      days.find((d) => d.d === state.hoveredDay) ||
      days.find((d) => d.d === todayKey) ||
      days[days.length - 1];
    const totalSpend = days.reduce((a, b) => a + (b.v || 0), 0);
    const totalTokens = snap.totalTokens;
    const activeN = days.filter((d) => d.v > 0).length;

    const totalForBar = Math.max(1, focused.v || 0, max);
    const monthLabel = monthHeaderLabel(focused?.d);

    return `<div class="heatmap-card">
      <div>
        <div class="heatmap-grid">
          ${dowLabels}
          ${cellHtml}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:14px;align-items:center;flex-wrap:wrap;gap:8px;">
          <div class="seg" style="padding:2px;">
            <button class="${state.dataKind === "spend" ? "active" : ""}" data-data-kind="spend" style="font-size:11px;padding:4px 8px;">${escapeHtml(t("Spend"))}</button>
            <button class="${state.dataKind === "tokens" ? "active" : ""}" data-data-kind="tokens" style="font-size:11px;padding:4px 8px;">${escapeHtml(t("Tokens"))}</button>
          </div>
          <div class="legend">
            <span>${escapeHtml(t("less"))}</span>
            <div class="scale">
              <i style="background:var(--bg-elev-2)"></i>
              <i style="background:oklch(0.35 0.06 50)"></i>
              <i style="background:oklch(0.50 0.12 55)"></i>
              <i style="background:oklch(0.62 0.16 50)"></i>
              <i style="background:oklch(0.72 0.18 45)"></i>
              <i style="background:oklch(0.80 0.18 70)"></i>
            </div>
            <span>${escapeHtml(t("more"))}</span>
          </div>
        </div>
      </div>
      <div class="heatmap-vsep"></div>
      <div class="heatmap-detail">
        <div class="day-label">${escapeHtml(monthLabel)}</div>
        <div class="day-date">${escapeHtml(fmtUsd(totalSpend))} · ${escapeHtml(fmtTokens(totalTokens))}</div>
        <div class="day-amt">${escapeHtml(t("{0} active days", String(activeN)))}</div>
        ${focused ? `
          <div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--line-soft);">
            <div class="day-label">${escapeHtml(focused.v > 0 ? t("Active day") : t("Quiet day"))} · ${escapeHtml(focused.d)}</div>
            <div class="day-bd">
              <div class="row">
                <span class="lbl">Claude</span>
                <span class="bar"><i style="width:${focused.v ? Math.min(100, (focused.claude / totalForBar) * 100) : 0}%;background:var(--claude);"></i></span>
                <span class="v">${escapeHtml(fmtUsd(focused.claude))}</span>
              </div>
              <div class="row">
                <span class="lbl">Codex</span>
                <span class="bar"><i style="width:${focused.v ? Math.min(100, (focused.codex / totalForBar) * 100) : 0}%;background:var(--codex);"></i></span>
                <span class="v">${escapeHtml(fmtUsd(focused.codex))}</span>
              </div>
              <div class="row">
                <span class="lbl">${escapeHtml(t("Total"))}</span>
                <span class="bar"><i style="width:${Math.min(100, (focused.v / totalForBar) * 100)}%;background:linear-gradient(90deg,var(--fire-1),var(--fire-3));"></i></span>
                <span class="v">${escapeHtml(fmtUsd(focused.v))}</span>
              </div>
            </div>
            ${focused.v === 0 ? `
              <div class="mono mute" style="font-size:11.5px;margin-top:14px;line-height:1.7;">
                · ${escapeHtml(t("Look at this batch's top-cost session."))}<br/>
                · ${escapeHtml(t("Review which models drove burn that day."))}<br/>
                · ${escapeHtml(t("Compare month-over-month tool mix."))}
              </div>
            ` : ""}
          </div>
        ` : ""}
      </div>
    </div>`;
  }

  function renderProjects(snap) {
    if (!snap.projects.length) {
      return `<div class="proj-list"><div class="proj"><div class="mute mono">${escapeHtml(t("No usage data in this range. Try All Time."))}</div></div></div>`;
    }
    const rows = snap.projects.map((p) => {
      const claudePct = Math.round(p.claude * 100);
      const codexPct = Math.round(p.codex * 100);
      const open = state.expandedProjectPath === p.rawPath;
      const sessionList = []; // session-level data isn't currently emitted by the analyzer
      return `<div class="proj ${open ? "open" : ""}" data-project="${escapeHtml(p.rawPath)}">
        <div class="proj-head">
          <div class="proj-path" title="${escapeHtml(p.rawPath)}">
            <span class="chev">›</span>
            <span>${escapeHtml(p.path)}</span>
          </div>
          <div class="proj-tags">
            ${p.claude > 0 ? `<span class="tag claude">Claude</span>` : ""}
            ${p.codex > 0 ? `<span class="tag codex">Codex</span>` : ""}
            ${p.hasFlame ? `<span class="tag warn">${fireIconSvg(9)} hot</span>` : ""}
          </div>
        </div>
        <div class="proj-bars">
          <div class="proj-bar">
            ${p.claude > 0 ? `<i class="claude" style="width:${claudePct}%"></i>` : ""}
            ${p.codex > 0 ? `<i class="codex" style="width:${codexPct}%"></i>` : ""}
          </div>
          <div class="proj-mix">
            ${p.claude > 0 ? `<span><i class="dot claude"></i> Claude ${claudePct}%</span>` : ""}
            ${p.codex > 0 ? `<span><i class="dot codex"></i> Codex ${codexPct}%</span>` : ""}
          </div>
        </div>
        <div class="proj-figs">
          <span class="amt">${escapeHtml(fmtUsd(p.spend))}</span>
          <span class="meta">${p.sessions} ${escapeHtml(t("sessions"))} · ${escapeHtml(fmtTokens(p.tokens))}</span>
        </div>
        ${open ? `
          <div class="proj-detail">
            ${sessionList.length ? sessionList.map((s) => `
              <div class="sess">
                <span>${escapeHtml(s.model)}</span>
                <span class="when">${escapeHtml(s.ts)}</span>
                <span style="color:var(--fire-1);text-align:right;">${escapeHtml(fmtUsd(s.amt))} · ${escapeHtml(fmtTokens(s.tokens))}</span>
              </div>
            `).join("") : `<div class="empty">${escapeHtml(t("(no detailed sessions cached for this project)"))}</div>`}
          </div>
        ` : ""}
      </div>`;
    }).join("");
    return `<div class="proj-list">${rows}</div>`;
  }

  function renderModels(snap) {
    if (!snap.models.length) {
      return `<div class="models"><div class="model-row"><div class="mute mono">${escapeHtml(t("No usage data in this range. Try All Time."))}</div></div></div>`;
    }
    const max = Math.max(
      1,
      ...snap.models.map((m) => (m.spend > 0 ? m.spend : (m.tokens || 0) / 1e6 / 50)),
    );
    const rows = snap.models.map((m) => {
      const fillPct = Math.min(
        100,
        ((m.spend > 0 ? m.spend : (m.tokens || 0) / 1e6 / 50) / max) * 100,
      );
      const cls = m.tool === "Claude" ? "claude" : "codex";
      const numbers = m.spend > 0
        ? `<b>${escapeHtml(fmtUsd(m.spend))}</b> · ${escapeHtml(fmtTokens(m.tokens))} · ${m.calls.toLocaleString()} ${escapeHtml(t("calls"))} (${escapeHtml(fmtPct(m.share * 100, 1))})`
        : `${escapeHtml(fmtTokens(m.tokens))} · ${m.calls.toLocaleString()} ${escapeHtml(t("calls"))}`;
      return `<div class="model-row ${cls}">
        <div class="name">
          <span>${escapeHtml(m.name)}</span>
          <span class="tag ${cls}">${m.tool}</span>
          ${m.free ? `<span class="tag warn">${escapeHtml(t("free"))}</span>` : ""}
        </div>
        <div class="ratiobar"><i style="width:${fillPct}%"></i></div>
        <div class="nums">${numbers}</div>
      </div>`;
    }).join("");
    return `<div class="models">${rows}</div>`;
  }

  function renderBatches(snap) {
    const head = `<div class="batch-head">
      <span style="display:inline-flex;align-items:center;gap:8px;">${fireIconSvg(11)}${escapeHtml(t("Priced > $1.00 / batch · unpriced ranked by token volume"))}</span>
      <span>${snap.batches.length} ${escapeHtml(t("batches"))}</span>
    </div>`;
    if (!snap.batches.length) {
      return `<div class="batch">${head}<div class="batch-empty">${escapeHtml(t("No spike batches in this range."))}</div></div>`;
    }
    const rows = snap.batches.map((b) => {
      const danger = b.amt > 5;
      return `<div class="batch-row ${danger ? "danger" : ""}" data-batch-path="${escapeHtml(b.rawPath)}" data-batch-when="${escapeHtml(b.when)}">
        <span class="amt">${escapeHtml(fmtUsd(b.amt))}</span>
        <span class="tok">${escapeHtml(b.tok)} ${escapeHtml(t("Tokens"))}</span>
        <span class="path" title="${escapeHtml(b.rawPath)}">${escapeHtml(b.path)}</span>
        <span class="model">${escapeHtml(b.model)}</span>
        <span class="when">${escapeHtml(b.when)}</span>
        <span class="arr">›</span>
      </div>`;
    }).join("");
    return `<div class="batch">${head}${rows}</div>`;
  }

  /* ------------------------------------------------------------------
   * Top-level render
   * ------------------------------------------------------------------ */
  function render() {
    document.body.classList.toggle("locale-zh", state.locale === "zh-cn");
    // Push the resolved theme onto <html> so the CSS palette switches
    // even when the user picks Auto and the OS theme flips later.
    document.documentElement.setAttribute("data-theme", resolveTheme());

    if (state.error) {
      root.innerHTML = `<div class="error">${escapeHtml(t("Error: {0}", state.error))}</div>`;
      return;
    }
    if (!state.payload) {
      root.innerHTML = `<div class="loading">${escapeHtml(t("Loading…"))}</div>`;
      return;
    }

    const snap = deriveSnapshot(state.payload);
    const totalSessions = snap.sessions;
    const syncedAt = friendlyTimestamp(state.payload.result.generatedAt);

    root.innerHTML = `
      ${renderTopbar(snap, syncedAt, totalSessions)}
      ${renderFilterBar(snap)}
      ${renderBurnHero(snap)}
      ${renderStatStrip(snap)}
      <div class="section">
        <div class="section-h">
          <h2>${escapeHtml(t("Daily activity"))}</h2>
          <div class="section-actions">
            <span class="mono mute" style="font-size:11px;">${escapeHtml(monthHeaderLabel(snap.daily[snap.daily.length - 1]?.d))}</span>
          </div>
        </div>
        ${renderHeatmap(snap)}
      </div>
      <div class="section">
        <div class="section-h"><h2>${escapeHtml(t("Projects"))}</h2></div>
        ${renderProjects(snap)}
      </div>
      <div class="section">
        <div class="section-h"><h2>${escapeHtml(t("By model"))}</h2></div>
        ${renderModels(snap)}
      </div>
      <div class="section">
        <div class="section-h">
          <h2>${escapeHtml(t("Top burns"))}</h2>
        </div>
        ${renderBatches(snap)}
      </div>
    `;
  }

  /* ------------------------------------------------------------------
   * Helpers
   * ------------------------------------------------------------------ */
  function todayLocalKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function parseLocalDate(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  function monthHeaderLabel(iso) {
    const d = iso ? parseLocalDate(iso) : new Date();
    if (!d) return "";
    if (state.locale === "zh-cn") return `${d.getFullYear()}年${d.getMonth() + 1}月`;
    const months = ["January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"];
    return `${months[d.getMonth()]} ${d.getFullYear()}`;
  }
  function friendlyTimestamp(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
      return iso;
    }
  }

  /* ------------------------------------------------------------------
   * Event handling — single delegated handler on #app.
   * ------------------------------------------------------------------ */
  root.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;

    const action = target.closest("[data-action]");
    if (action) {
      const a = action.getAttribute("data-action");
      if (a === "refresh") {
        // Re-issue the current range/provider — host emits a fresh data message.
        vscode.postMessage({ type: "setRange", range: state.range, provider: state.provider });
      }
      return;
    }

    const themeBtn = target.closest("[data-theme-pick]");
    if (themeBtn) {
      const pick = themeBtn.getAttribute("data-theme-pick");
      if (VALID_THEMES.includes(pick) && pick !== state.theme) {
        state.theme = pick;
        persist();
        render();
      }
      return;
    }

    const langBtn = target.closest("[data-lang]");
    if (langBtn) {
      const lang = langBtn.getAttribute("data-lang") === "zh-cn" ? "zh-cn" : "en";
      vscode.postMessage({ type: "setLocale", locale: lang });
      // Optimistic flip — the host will confirm with an `i18n` message.
      state.locale = lang;
      persist();
      render();
      return;
    }

    const rangeBtn = target.closest("[data-range]");
    if (rangeBtn) {
      const r = rangeBtn.getAttribute("data-range");
      if (VALID_RANGES.includes(r) && r !== state.range) {
        state.range = r;
        persist();
        vscode.postMessage({ type: "setRange", range: r });
      }
      return;
    }

    const toolBtn = target.closest("[data-tool]");
    if (toolBtn) {
      const tool = toolBtn.getAttribute("data-tool");
      if (VALID_PROVIDERS.includes(tool) && tool !== state.provider) {
        state.provider = tool;
        persist();
        vscode.postMessage({ type: "setProvider", provider: tool });
      }
      return;
    }

    const dataKindBtn = target.closest("[data-data-kind]");
    if (dataKindBtn) {
      const kind = dataKindBtn.getAttribute("data-data-kind");
      if ((kind === "spend" || kind === "tokens") && kind !== state.dataKind) {
        state.dataKind = kind;
        persist();
        render();
      }
      return;
    }

    const projRow = target.closest("[data-project]");
    if (projRow) {
      const p = projRow.getAttribute("data-project");
      state.expandedProjectPath = state.expandedProjectPath === p ? null : p;
      render();
      return;
    }

    // Batch row clicks are intentionally a no-op — the design notes that
    // session detail is "out of scope for this view". We still treat the
    // row as interactive so the cursor: pointer styling doesn't lie.
  });

  // Heatmap hover updates the detail panel without poking the host.
  root.addEventListener("mouseover", (ev) => {
    const cell = ev.target instanceof Element ? ev.target.closest("[data-day]") : null;
    if (!cell) return;
    const day = cell.getAttribute("data-day");
    if (day && day !== state.hoveredDay) {
      state.hoveredDay = day;
      render();
    }
  });

  /* ------------------------------------------------------------------
   * Persistence
   * ------------------------------------------------------------------ */
  function persist() {
    vscode.setState({
      range: state.range,
      provider: state.provider,
      dataKind: state.dataKind,
      theme: state.theme,
    });
  }

  /* ------------------------------------------------------------------
   * Host messages
   * ------------------------------------------------------------------ */
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "data") {
      if (typeof msg.requestId === "number") {
        if (msg.requestId < state.lastRequestId) return;
        state.lastRequestId = msg.requestId;
      }
      state.payload = msg;
      state.error = null;
      if (msg.range && VALID_RANGES.includes(msg.range)) state.range = msg.range;
      if (msg.provider && VALID_PROVIDERS.includes(msg.provider)) state.provider = msg.provider;
      if (msg.i18n && typeof msg.i18n === "object") state.i18n = msg.i18n;
      if (typeof msg.locale === "string") state.locale = msg.locale;
      render();
      return;
    }

    if (msg.type === "i18n") {
      if (msg.bundle && typeof msg.bundle === "object") state.i18n = msg.bundle;
      if (typeof msg.locale === "string") state.locale = msg.locale;
      render();
      return;
    }

    if (msg.type === "error") {
      state.error = msg.message || "Unknown error";
      render();
      return;
    }
  });

  // Live-follow OS theme changes when the user is on Auto.
  if (typeof window.matchMedia === "function") {
    try {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => { if (state.theme === "auto") render(); };
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
      else if (typeof mq.addListener === "function") mq.addListener(onChange);
    } catch { /* noop */ }
  }

  // Kick off the first analysis. The host responds with a `data` message;
  // until then, the loading state remains.
  vscode.postMessage({ type: "ready", provider: state.provider, range: state.range });
})();
