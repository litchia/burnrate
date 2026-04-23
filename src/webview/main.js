(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById("content");
  const generatedAt = document.getElementById("generatedAt");
  const persisted = vscode.getState() || {};
  const state = {
    metric: "tokens",
    selectedMonth: null,
    payload: null,
    lastRequestId: 0,
    lastHoverKey: "",
    provider: persisted.provider === "claude-code" || persisted.provider === "codex" ? persisted.provider : "all",
    unknownBannerExpanded: persisted.unknownBannerExpanded === true,
    dismissedUnknownSignature: typeof persisted.dismissedUnknownSignature === "string" ? persisted.dismissedUnknownSignature : "",
    // i18n: dictionary pushed by the extension. Keys ARE the English source
    // string (matches @vscode/l10n convention). Empty until first message —
    // `t()` falls back to the key, so static English in index.html still
    // renders correctly during the boot window.
    i18n: {},
    locale: "en",
  };

  /**
   * Translate. Pass the English source string as the key. Positional
   * placeholders use {0}, {1}, … (matches src/i18n.ts).
   *   t("Total Spend")
   *   t("Cache reuse: {0}%", "12.4")
   */
  function t(key, ...args) {
    const template = (state.i18n && state.i18n[key]) || key;
    return template.replace(/\{(\d+)\}/g, (m, idxStr) => {
      const idx = Number(idxStr);
      return Number.isInteger(idx) && idx >= 0 && idx < args.length ? String(args[idx]) : m;
    });
  }

  /** Singular / plural picker. See src/i18n.ts `tn`. */
  function tn(keyOne, keyOther, count, ...args) {
    return t(count === 1 ? keyOne : keyOther, ...args);
  }

  /** Apply translations to every static [data-i18n] element. Idempotent —
   *  safe to call again after `state.i18n` updates. Used for toolbar / h1 /
   *  sub elements that exist in index.html before any render() runs. */
  function applyStaticI18n(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (!key) return;
      el.textContent = t(key);
    });
    // Locale-aware body class so CSS can opt out of `text-transform:uppercase`
    // for Chinese (otherwise embedded English words render as shouty TOKEN/CODEX).
    document.body.classList.toggle("locale-zh", state.locale === "zh-cn");
  }

  document.querySelectorAll(".range-pill").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".range-pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      vscode.postMessage({ type: "setRange", range: b.dataset.range });
      content.innerHTML = `<div class="empty">${t("Loading…")}</div>`;
    });
  });

  document.querySelectorAll(".provider-pill").forEach((b) => {
    if (b.dataset.provider === state.provider) b.classList.add("active");
    else b.classList.remove("active");
    b.addEventListener("click", () => {
      document.querySelectorAll(".provider-pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.provider = normalizeProvider(b.dataset.provider);
      persistState();
      vscode.postMessage({ type: "setProvider", provider: state.provider });
      content.innerHTML = `<div class="empty">${t("Loading…")}</div>`;
    });
  });

  document.getElementById("refreshBtn").addEventListener("click", () => {
    const active = document.querySelector(".range-pill.active");
    vscode.postMessage({ type: "setRange", range: active.dataset.range });
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "data") {
      const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
      if (requestId && requestId < state.lastRequestId) return;
      if (requestId) state.lastRequestId = requestId;
      state.payload = msg;
      if (msg.i18n && typeof msg.i18n === "object") {
        state.i18n = msg.i18n;
        if (typeof msg.locale === "string") state.locale = msg.locale;
        applyStaticI18n();
      }
      syncState();
      syncToolbar();
      try {
        renderCurrent();
      } catch (err) {
        content.innerHTML = `<div class="empty">${t("Render error: {0}", escapeHtml(err?.message || String(err)))}</div>`;
      }
    } else if (msg.type === "i18n") {
      if (msg.bundle && typeof msg.bundle === "object") {
        state.i18n = msg.bundle;
        if (typeof msg.locale === "string") state.locale = msg.locale;
        applyStaticI18n();
        if (state.payload) {
          try {
            renderCurrent();
          } catch (err) {
            content.innerHTML = `<div class="empty">${t("Render error: {0}", escapeHtml(err?.message || String(err)))}</div>`;
          }
        }
      }
    } else if (msg.type === "error") {
      const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
      if (requestId && requestId < state.lastRequestId) return;
      if (requestId) state.lastRequestId = requestId;
      content.innerHTML = `<div class="empty">${t("Error: {0}", escapeHtml(msg.message))}</div>`;
    }
  });

  document.body.addEventListener("click", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;
    if (action === "openSettings") {
      e.preventDefault();
      vscode.postMessage({ type: "openSettings" });
      return;
    }
    if (!state.payload) return;

    if (action === "setMetric") {
      state.metric = target.dataset.metric === "tokens" ? "tokens" : "cost";
      renderCurrent();
      return;
    }

    if (action === "toggleUnknownBanner") {
      state.unknownBannerExpanded = !state.unknownBannerExpanded;
      persistState();
      renderCurrent();
      return;
    }

    if (action === "dismissUnknownBanner") {
      state.dismissedUnknownSignature = target.dataset.signature || "";
      persistState();
      renderCurrent();
      return;
    }

    if (action === "ignoreUnknownModel" && target.dataset.model) {
      vscode.postMessage({ type: "ignoreModel", model: target.dataset.model });
      return;
    }

    if (action === "selectMonth" && target.dataset.month) {
      state.selectedMonth = target.dataset.month;
      renderCurrent();
    }
  });

  document.body.addEventListener("keydown", (e) => {
    const target = e.target.closest("[data-action]");
    if (!target) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    target.click();
  });

  document.body.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-hover-label]");
    if (!target) return;
    updateHoverDetail(target.dataset);
  });

  function updateHoverDetail(dataset) {
    const label = document.getElementById("heatmap-hover-label");
    const meta = document.getElementById("heatmap-hover-meta");
    const models = document.getElementById("heatmap-hover-models");
    const tools = document.getElementById("heatmap-hover-tools");
    if (!label || !meta || !models || !state.payload) return;
    const hoverKey = `${dataset.hoverScope || ""}:${dataset.hoverBucket || ""}`;
    if (hoverKey && hoverKey === state.lastHoverKey) return;
    state.lastHoverKey = hoverKey;
    label.textContent = dataset.hoverLabel || t("Hover a cell");
    meta.textContent = t("Spend {0} · Usage {1}", dataset.hoverSpend || "$0.00", dataset.hoverTokens || "0");
    models.innerHTML = renderHoverModels(dataset.hoverBucket || "", dataset.hoverScope || "");
    if (tools) tools.innerHTML = renderHoverProviders(dataset.hoverBucket || "", dataset.hoverScope || "");
  }

  syncToolbar();
  applyStaticI18n();
  vscode.postMessage({ type: "ready", provider: state.provider });

  function persistState() {
    vscode.setState({
      provider: state.provider,
      unknownBannerExpanded: state.unknownBannerExpanded,
      dismissedUnknownSignature: state.dismissedUnknownSignature,
    });
  }

  function syncToolbar() {
    document.querySelectorAll(".provider-pill").forEach((button) => {
      button.classList.toggle("active", button.dataset.provider === state.provider);
    });
  }

  function syncState() {
    if (!state.payload) return;
    const { result, range, provider } = state.payload;
    state.provider = normalizeProvider(provider);
    persistState();
    const months = buildAvailableMonths(result);
    const dataMonths = buildDataMonths(result);

    if (range === "today") {
      state.selectedMonth = null;
      return;
    }

    if (range === "month") {
      state.selectedMonth = localMonthKey(new Date());
      return;
    }

    if (months.length === 0) {
      state.selectedMonth = localMonthKey(new Date());
      return;
    }

    if (!state.selectedMonth || !months.includes(state.selectedMonth) || !dataMonths.includes(state.selectedMonth)) {
      state.selectedMonth = dataMonths[dataMonths.length - 1] || months[months.length - 1];
    }
  }

  function renderCurrent() {
    if (!state.payload) return;
    const { result, range, rootExists, pricingMeta, rootStatus, provider } = state.payload;
    render(result, range, rootExists, pricingMeta, rootStatus || {}, normalizeProvider(provider));
  }

  function render(result, range, rootExists, pricingMeta, rootStatus, provider) {
    if (!rootExists) {
      content.innerHTML = `<div class="empty">${t("No Claude Code or Codex logs found in the default local log directories. Use either CLI at least once to generate logs.")}</div>`;
      return;
    }
    if (result.totals.messages === 0) {
      content.innerHTML = `<div class="empty">${renderEmptyState(range, provider, rootStatus)}</div>`;
      generatedAt.textContent = t("Scanned {0} session files · no messages in range", result.scannedFiles);
      return;
    }

    generatedAt.textContent = t("Scanned {0} session files · updated {1}", result.scannedFiles, new Date(result.generatedAt).toLocaleTimeString());

    const totals = result.totals;
    const cacheTotalIn = totals.inTokens + totals.cacheRead + totals.cacheWrite;
    const hitRate = cacheTotalIn > 0 ? (totals.cacheRead / cacheTotalIn) * 100 : 0;
    const totalTokens = totals.inTokens + totals.outTokens + totals.cacheRead + totals.cacheWrite;

    const projects = Object.values(result.byProject).sort((a, b) => b.cost - a.cost);
    const topProjects = projects.slice(0, 8);
    const maxProjCost = topProjects[0]?.cost || 1;

    const models = Object.entries(result.byModel).sort(([, a], [, b]) => b.cost - a.cost);
    const spikes = result.spikes || [];
    const unknown = result.unknownModels || [];
    const pricedSpikes = spikes.filter((s) => s.isKnown).sort((a, b) => b.cost - a.cost);
    const unpricedSpikes = spikes.filter((s) => !s.isKnown).sort((a, b) => b.tokens - a.tokens);
    const providerSummary = result.byProvider || {};
    const codexQuota = result.codexQuota || null;
    const totalCost = totals.cost || 0;
    // i18n worked example: branch first, then translate the chosen English
    // source string. Keys mirror the English text exactly. See I18N_CONVENTIONS.md.
    const spendLabel = provider === "codex" ? t("Implied API Spend") : t("Total Spend");
    const spendMetaSuffix = provider === "codex" && codexQuota
      ? ` · <span class="inline-pill">${t("Plan: {0}", formatPlanType(codexQuota.planType))}</span>`
      : "";

    content.innerHTML = `
      ${renderPricingBanner(pricingMeta, unknown)}

      <div class="cards">
          <div class="card">
          <div class="label">${spendLabel}${state.locale === "zh-cn" ? "（" : " ("}${rangeLabel(range)}${state.locale === "zh-cn" ? "）" : ")"}</div>
          <div class="value">$${fmt(totals.cost, 2)}</div>
          <div class="meta">${totals.messages.toLocaleString()} ${t("assistant turns")} · ${totals.sessions} ${t("sessions")}${provider === "codex" ? ` · ${t("API-rate estimate")}` : ""}${totals.syntheticMessages ? ` · ${totals.syntheticMessages} ${t("synthetic excluded")}` : ""}${totals.unknownMessages ? ` · <span class="warn">${totals.unknownMessages} ${t("with unknown pricing")}</span>` : ""}${spendMetaSuffix}</div>
        </div>
        <div class="card">
          <div class="label">${t("Tokens Used")}</div>
          <div class="value">${fmtTokens(totalTokens)}</div>
          <div class="meta">${t("Cache reuse: {0}%", hitRate.toFixed(1))}</div>
        </div>
        ${provider === "all" ? `
          <div class="card">
            <div class="label">${t("By Tool")}</div>
            <div class="provider-breakdown">
              ${renderProviderBreakdownCard(providerSummary, totalCost)}
            </div>
          </div>
        ` : ""}
        ${provider === "codex" ? renderQuotaCard(codexQuota) : `
          <div class="card">
            <div class="label">${t("Top Project")}</div>
            <div class="value" style="font-size:18px; word-break:break-all;">${escapeHtml(shortPath(topProjects[0]?.project || "—"))}</div>
            <div class="meta">$${fmt(topProjects[0]?.cost || 0, 2)} · ${topProjects[0]?.sessions || 0} ${t("sessions")}</div>
          </div>
        `}
      </div>

      ${provider === "codex" ? renderRateLimitsSection(codexQuota) : ""}

      ${provider !== "codex" ? `
        <div class="quota-unavailable-note">
          <span>ℹ ${t("Claude Code does not expose subscription quota in local logs, so BurnRate can only show implied API spend. Codex exposes it, so a Quota card is shown there.")}</span>
        </div>
      ` : ""}

      ${renderHeatmapSection(result, range)}

      <div class="section">
        <h2>${t("Projects")}</h2>
        <div>
          ${topProjects.map((p) => `
            <div class="project-row">
              <div>
                <div class="project-name" title="${escapeHtml(p.project)}">${escapeHtml(shortPath(p.project))}${provider === "all" ? renderProviderBadges(extractProviderIds(p.providers)) : ""}${p.unknownTokens > 0 ? ` <span class="warn-pill" title="${t("No pricing match — counted as $0")}">⚠</span>` : ""}</div>
                <div class="bar-wrap" style="margin-top:6px;"><div class="bar" style="width:${(p.cost / maxProjCost * 100).toFixed(1)}%"></div></div>
                ${provider === "all" ? renderProjectToolShare(p.providers) : ""}
              </div>
              <div class="project-cost">$${fmt(p.cost, 2)}</div>
              <div class="project-meta">${p.sessions} ${t("sess")}<br/>${fmtTokens(p.inTokens + p.outTokens + p.cacheRead + p.cacheWrite)}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="section">
        <h2>${t("By Model")}</h2>
        <div>
          ${models.map(([m, s]) => `
            <div class="model-row">
              <span class="name">${escapeHtml(m)}${provider === "all" ? renderProviderBadges(extractProviderIds(s.providers)) : ""}${s.isKnown ? "" : ` <span class="warn-pill" title="${t("No pricing match — counted as $0")}">⚠ ${t("unpriced")}</span>`}</span>
              <span>${s.isKnown ? "$" + fmt(s.cost, 2) + " · " : ""}${fmtTokens(s.tokens)} · ${s.messages} ${t("tokens")}${s.isKnown && totals.cost > 0 ? ` (${(s.cost / totals.cost * 100).toFixed(1)}%)` : ""}</span>
            </div>
          `).join("")}
        </div>
      </div>

      ${(pricedSpikes.length || unpricedSpikes.length) ? `
        <div class="section">
          <h2>${t("Spike Turns")}</h2>
          <div class="section-meta">${t("Priced spikes: >${0} per turn · Unpriced spikes: token-based (high token volume)", fmt(pricingMeta?.spikeThreshold || 1, 2))}</div>
          <div class="alerts">
            ${pricedSpikes.slice(0, 10).map((s) => `
              <div class="alert-row">
                <span class="cost">$${fmt(s.cost, 2)}</span>
                · ${escapeHtml(fmtTokens(s.tokens))} ${t("tokens")}
                · ${escapeHtml(shortPath(s.project))}
                · ${escapeHtml(s.model)}${provider === "all" ? renderProviderBadges([s.provider]) : ""}
                · ${escapeHtml(formatSpikeTimestamp(s.ts))}
              </div>
            `).join("")}
            ${unpricedSpikes.length ? `<div class="alert-subhead">${t("High token volume (unpriced models)")}</div>` : ""}
            ${unpricedSpikes.slice(0, 10).map((s) => `
              <div class="alert-row">
                <span class="cost">${escapeHtml(fmtTokens(s.tokens))} ${t("tokens")}</span>
                · ${escapeHtml(shortPath(s.project))}
                · ${escapeHtml(s.model)}${provider === "all" ? renderProviderBadges([s.provider]) : ""} <span class="warn-pill" title="${t("No pricing match — spike is token-based")}">${t("unpriced")}</span>
                · ${escapeHtml(formatSpikeTimestamp(s.ts))}
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
    `;
  }

  function renderHeatmapSection(result, range) {
    const currentMetric = state.metric === "tokens" ? "tokens" : "cost";
    const selectedMonth = range === "today" ? null : (state.selectedMonth || localMonthKey(new Date()));
    const title = range === "today" ? t("Hourly Heatmap") : t("Calendar Heatmap");
    const controls = `
      <div class="segmented">
        <button class="seg-btn ${currentMetric === "cost" ? "active" : ""}" data-action="setMetric" data-metric="cost">${t("Spend")}</button>
        <button class="seg-btn ${currentMetric === "tokens" ? "active" : ""}" data-action="setMetric" data-metric="tokens">${t("Usage")}</button>
        ${range !== "today" ? `
          <div class="month-label">${escapeHtml(formatMonthLabel(selectedMonth))}</div>
        ` : ""}
      </div>
    `;

    return `
      <div class="section">
        <div class="section-head">
          <h2>${title}</h2>
          ${controls}
        </div>
        ${range === "all" ? renderAllTimeOverview(result, selectedMonth, currentMetric) : ""}
        ${range === "today" ? renderHourlyHeatmap(result, currentMetric, state.provider) : renderMonthlyHeatmap(result, selectedMonth, currentMetric, state.provider)}
      </div>
    `;
  }

  function renderAllTimeOverview(result, selectedMonth, metric) {
    const months = buildAvailableMonths(result);
    if (months.length === 0) return "";
    if (months.length <= 12) {
      return `
        <div class="heatmap-overview-grid">
          ${months.map((month) => renderMiniMonthCard(result, month, metric, month === selectedMonth)).join("")}
        </div>
      `;
    }

    const years = groupMonthsByYear(months);
    return years.map(([year, yearMonths]) => `
      <div class="year-group">
        <h3 class="year-divider">${escapeHtml(year)}</h3>
        <div class="heatmap-overview-grid">
          ${yearMonths.map((month) => renderMiniMonthCard(result, month, metric, month === selectedMonth)).join("")}
        </div>
      </div>
    `).join("");
  }

  function renderMiniMonthCard(result, monthKey, metric, isActive) {
    const calendar = buildMonthCalendar(monthKey);
    const values = metric === "tokens" ? (result.byDayTokens || {}) : (result.byDay || {});
    const monthValues = Array.from({ length: calendar.daysInMonth }, (_, index) => values[dayKey(monthKey, index + 1)] || 0);
    const maxValue = Math.max(...monthValues, 0);
    const hasData = monthValues.some((value) => value > 0);
    const cells = calendar.slots.map((slot) => {
      if (!slot.day) return `<div class="heatmap-cell empty"></div>`;
      const key = dayKey(monthKey, slot.day);
      const value = values[key] || 0;
      return `<div class="heatmap-cell active" style="background:${heatColor(value, maxValue)}"></div>`;
    }).join("");
    const actionAttrs = hasData
      ? `data-action="selectMonth" data-month="${monthKey}" role="button" tabindex="0" aria-pressed="${isActive ? "true" : "false"}" aria-label="${t("Show {0}", escapeHtml(formatMonthLabel(monthKey)))}"`
      : `aria-disabled="true"`;
    return `
      <div class="mini-month ${isActive ? "active" : ""} ${hasData ? "" : "disabled"}" ${actionAttrs}>
        <div class="mini-month-title">${escapeHtml(formatMonthLabel(monthKey))}</div>
        <div class="mini-month-grid">${cells}</div>
      </div>
    `;
  }

  function renderHourlyHeatmap(result, metric, provider) {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const values = metric === "tokens" ? (result.byHourTokens || {}) : (result.byHour || {});
    const hours = [];
    for (let hour = 0; hour < 24; hour++) {
      const hh = String(hour).padStart(2, "0");
      const key = `${day} ${hh}:00`;
      hours.push({
        key,
        value: values[key] || 0,
        spend: result.byHour?.[key] || 0,
        tokens: result.byHourTokens?.[key] || 0,
      });
    }
    const maxValue = Math.max(...hours.map((h) => h.value), 0);
    const cells = hours.map((hour) => `
      <div
        class="hour-cell"
        style="background:${heatColor(hour.value, maxValue)}"
        title="${escapeHtml(buildTooltip(hour.key, hour.spend, hour.tokens))}"
        data-hover-label="${escapeHtml(hour.key)}"
        data-hover-spend="$${fmt(hour.spend, 4)}"
        data-hover-tokens="${escapeHtml(fmtTokens(hour.tokens))}"
        data-hover-bucket="${hour.key}"
        data-hover-scope="hour"
      >
        <span class="hour-cell-label">${hour.key.slice(11, 13)}</span>
      </div>
    `).join("");
    const summary = summarizeHours(hours);
    const hoverMeta = summary.activeHours === 0
      ? t("No activity yet today.")
      : t("Move over a square to inspect the exact bucket.");
    return `
      <div class="heatmap-detail-layout">
        <div class="heatmap-shell">
          <div class="large-hours-grid">${cells}</div>
          ${renderLegend(metric)}
        </div>
        ${renderDetailCard(t("Today ({0})", day), summary.scopeMeta, t("Hover an hour"), hoverMeta, provider === "all")}
      </div>
    `;
  }

  function renderMonthlyHeatmap(result, monthKey, metric, provider) {
    const month = monthKey || localMonthKey(new Date());
    const calendar = buildMonthCalendar(month);
    const costMap = result.byDay || {};
    const tokenMap = result.byDayTokens || {};
    const values = metric === "tokens" ? tokenMap : costMap;
    const activeValues = Array.from({ length: calendar.daysInMonth }, (_, index) => values[dayKey(month, index + 1)] || 0);
    const maxValue = Math.max(...activeValues, 0);
    const dayCells = calendar.slots.map((slot) => {
      if (!slot.day) return `<div class="large-cell empty"></div>`;
      const key = dayKey(month, slot.day);
      const value = values[key] || 0;
      const spend = costMap[key] || 0;
      const tokens = tokenMap[key] || 0;
      return `
        <div
          class="large-cell"
          style="background:${heatColor(value, maxValue)}"
          title="${escapeHtml(buildTooltip(key, spend, tokens))}"
          data-hover-label="${escapeHtml(key)}"
          data-hover-spend="$${fmt(spend, 4)}"
          data-hover-tokens="${escapeHtml(fmtTokens(tokens))}"
          data-hover-bucket="${key}"
          data-hover-scope="day"
        >
          <span class="large-cell-day">${slot.day}</span>
        </div>
      `;
    }).join("");
    const summary = summarizeMonth(month, result);
    const weekdayHead = [t("Sun"), t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat")]
      .map((label) => `<span>${label}</span>`).join("");

    return `
      <div class="heatmap-detail-layout">
        <div class="heatmap-shell">
          <div class="heatmap-month-wrap">
            <div class="large-calendar-head">${weekdayHead}</div>
            <div class="large-calendar-grid">
              ${dayCells}
            </div>
          </div>
          ${renderLegend(metric)}
        </div>
        ${renderDetailCard(formatMonthLabel(month), summary.scopeMeta, t("Hover a day"), t("Move over a square to inspect the exact date."), provider === "all")}
      </div>
    `;
  }

  function renderLegend(metric) {
    const palette = [0, 1, 2, 3, 4].map((level) => `
      <span class="legend-chip" style="background:${heatColor(level, 4)}"></span>
    `).join("");
    return `
      <div class="heatmap-legend">
        <span>${metric === "tokens" ? t("Usage volume by token count") : t("Spend intensity by cost")}</span>
        <div class="legend-scale">
          <span>${t("Less")}</span>
          ${palette}
          <span>${t("More")}</span>
        </div>
      </div>
    `;
  }

  function renderDetailCard(scopeTitle, scopeMeta, hoverLabel, hoverMeta, includeToolBreakdown) {
    return `
      <div class="detail-card">
        <div class="detail-block">
          <div class="detail-label">${t("Scope")}</div>
          <div class="detail-value">${escapeHtml(scopeTitle)}</div>
          <div class="detail-meta">${escapeHtml(scopeMeta)}</div>
        </div>
        <div class="detail-block">
          <div class="detail-label">${t("Hover")}</div>
          <div class="detail-value" id="heatmap-hover-label">${escapeHtml(hoverLabel)}</div>
          <div class="detail-meta" id="heatmap-hover-meta">${escapeHtml(hoverMeta)}</div>
          <div class="detail-models" id="heatmap-hover-models">
            <div class="detail-empty">${t("Hover a cell to see model breakdown.")}</div>
          </div>
          ${includeToolBreakdown ? `
            <div class="detail-tools" id="heatmap-hover-tools">
              <div class="detail-empty">${t("Hover a cell to see tool breakdown.")}</div>
            </div>
          ` : ""}
        </div>
      </div>
    `;
  }

  function renderPricingBanner(meta, unknown) {
    if (!meta) return "";
    const bits = [];
    if (meta.customCount) bits.push(`<b>${meta.customCount}</b> ${t("custom")}`);
    bits.push(`<b>${meta.builtinCount || 0}</b> ${t("built-in")}`);

    let banner = `<div class="pricing-meta">${t("Pricing sources: {0}", bits.join(" · "))} · <a href="#" data-action="openSettings">${t("configure")}</a></div>`;

    const ignored = Array.isArray(meta.ignoredUnpricedModels) ? meta.ignoredUnpricedModels : [];
    const visibleUnknown = unknown.filter((model) => !ignored.includes(model));
    if (visibleUnknown.length > 0) {
      const signature = visibleUnknown.join("|");
      if (state.dismissedUnknownSignature !== signature) {
        const expanded = state.unknownBannerExpanded;
        banner += `
          <div class="warn-banner ${expanded ? "expanded" : "collapsed"}">
            <div class="warn-banner-head">
              <span>⚠ ${tn("{0} model unpriced and currently counted as $0.", "{0} models unpriced and currently counted as $0.", visibleUnknown.length, visibleUnknown.length)}</span>
              <div class="warn-banner-actions">
                <button class="warn-banner-btn" data-action="toggleUnknownBanner">${expanded ? t("Collapse") : t("Expand")}</button>
                <button class="warn-banner-btn" data-action="dismissUnknownBanner" data-signature="${escapeHtml(signature)}">${t("Dismiss")}</button>
              </div>
            </div>
            ${expanded ? `
              <div class="warn-banner-body">
                <div class="warn-banner-copy">
                  ${t("Add pricing via customPricing, or ignore models you intentionally do not want in this warning.")}
                </div>
                <div class="warn-banner-list">
                  ${visibleUnknown.map((model) => `
                    <div class="warn-banner-row">
                      <code>${escapeHtml(model)}</code>
                      <span class="warn-banner-row-actions">
                        <button class="warn-banner-btn" data-action="ignoreUnknownModel" data-model="${escapeHtml(model)}">${t("Ignore")}</button>
                      </span>
                    </div>
                  `).join("")}
                </div>
              </div>
            ` : ""}
          </div>
        `;
      }
    }
    return banner;
  }

  function buildAvailableMonths(result) {
    const rawMonths = buildDataMonths(result);
    if (rawMonths.length === 0) return [];
    const months = [];
    let cursor = rawMonths[0];
    const end = rawMonths[rawMonths.length - 1];
    while (cursor <= end) {
      months.push(cursor);
      cursor = addMonth(cursor, 1);
    }
    return months;
  }

  function buildDataMonths(result) {
    const dayKeys = Object.keys(result.byDay || {});
    const tokenKeys = Object.keys(result.byDayTokens || {});
    return [...dayKeys, ...tokenKeys]
      .map((day) => day.slice(0, 7))
      .filter((month, index, list) => month.length === 7 && list.indexOf(month) === index)
      .sort();
  }

  function buildTooltip(label, spend, tokens) {
    return `${label}\n${t("Spend")}: $${fmt(spend, 4)}\n${t("Usage")}: ${fmtTokens(tokens)}`;
  }

  function renderHoverModels(bucketKey, scope) {
    if (!state.payload || !bucketKey || !scope) {
      return `<div class="detail-empty">${t("Hover a cell to see model breakdown.")}</div>`;
    }
    const result = state.payload.result;
    const models = scope === "hour"
      ? (result.byHourModels?.[bucketKey] || {})
      : (result.byDayModels?.[bucketKey] || {});
    const entries = Object.entries(models).sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens);
    if (entries.length === 0) {
      return `<div class="detail-empty">${t("No model-level data in this bucket.")}</div>`;
    }
    return entries.map(([model, stat]) => `
      <div class="detail-model-row">
        <div class="detail-model-name" title="${escapeHtml(model)}">
          ${escapeHtml(model)}${state.provider === "all" ? renderProviderBadges(extractProviderIds(stat.providers)) : ""}${stat.isKnown ? "" : ` <span class="detail-model-badge">${t("unpriced")}</span>`}
        </div>
        <div class="detail-model-metrics">$${fmt(stat.cost, 4)} · ${fmtTokens(stat.tokens)}</div>
      </div>
    `).join("");
  }

  function renderHoverProviders(bucketKey, scope) {
    if (!state.payload || state.provider !== "all" || !bucketKey || !scope) {
      return `<div class="detail-empty">${t("Hover a cell to see tool breakdown.")}</div>`;
    }
    const result = state.payload.result;
    const bucket = scope === "hour"
      ? (result.byHourProviders?.[bucketKey] || {})
      : (result.byDayProviders?.[bucketKey] || {});
    const entries = Object.entries(bucket).sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens);
    if (entries.length === 0) {
      return `<div class="detail-empty">${t("No tool-level data in this bucket.")}</div>`;
    }
    return entries.map(([provider, stat]) => `
      <div class="detail-model-row">
        <div class="detail-model-name">${renderProviderBadges([provider], false)}</div>
        <div class="detail-model-metrics">$${fmt(stat.cost, 4)} · ${fmtTokens(stat.tokens)}</div>
      </div>
    `).join("");
  }

  function summarizeMonth(month, result) {
    let spend = 0;
    let tokens = 0;
    let activeDays = 0;
    for (const [key, value] of Object.entries(result.byDay || {})) {
      if (!key.startsWith(month)) continue;
      spend += value;
      tokens += result.byDayTokens?.[key] || 0;
      if ((result.byDayTokens?.[key] || 0) > 0) activeDays++;
    }
    return {
      scopeMeta: `$${fmt(spend, 2)} · ${fmtTokens(tokens)} · ${tn("{0} active day", "{0} active days", activeDays, activeDays)}`,
    };
  }

  function summarizeHours(hours) {
    const spend = hours.reduce((sum, hour) => sum + hour.spend, 0);
    const tokens = hours.reduce((sum, hour) => sum + hour.tokens, 0);
    const activeHours = hours.filter((hour) => hour.tokens > 0).length;
    return {
      scopeMeta: `$${fmt(spend, 2)} · ${fmtTokens(tokens)} · ${tn("{0} active hour", "{0} active hours", activeHours, activeHours)}`,
      activeHours,
    };
  }

  function buildMonthCalendar(monthKey) {
    const year = Number(monthKey.slice(0, 4));
    const monthIndex = Number(monthKey.slice(5, 7)) - 1;
    const firstDay = new Date(year, monthIndex, 1);
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const leadingEmpty = firstDay.getDay();
    const slots = [];
    for (let i = 0; i < leadingEmpty; i++) slots.push({ day: null });
    for (let day = 1; day <= daysInMonth; day++) slots.push({ day });
    while (slots.length < 42) slots.push({ day: null });
    return { daysInMonth, slots };
  }

  function dayKey(monthKey, day) {
    return `${monthKey}-${String(day).padStart(2, "0")}`;
  }

  function heatColor(value, maxValue) {
    if (value <= 0 || maxValue <= 0) return "var(--heat-0)";
    const ratio = value / maxValue;
    if (ratio >= 0.85) return "var(--heat-4)";
    if (ratio >= 0.6) return "var(--heat-3)";
    if (ratio >= 0.35) return "var(--heat-2)";
    if (ratio >= 0.12) return "var(--heat-1)";
    return "var(--heat-0)";
  }

  function localMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function addMonth(monthKey, delta) {
    const [year, month] = monthKey.split("-").map(Number);
    const date = new Date(year, month - 1 + delta, 1);
    return localMonthKey(date);
  }

  function groupMonthsByYear(months) {
    const grouped = new Map();
    months.forEach((month) => {
      const year = month.slice(0, 4);
      if (!grouped.has(year)) grouped.set(year, []);
      grouped.get(year).push(month);
    });
    return Array.from(grouped.entries());
  }

  function formatMonthLabel(monthKey) {
    if (!monthKey) return "";
    const [year, month] = monthKey.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "long" });
  }

  function formatSpikeTimestamp(ts) {
    if (!ts) return "";
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return String(ts).replace("T", " ").slice(0, 16);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function fmt(n, d) { return Number(n).toFixed(d); }

  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }

  function shortPath(p) {
    if (!p) return "—";
    // Split on both POSIX "/" and Windows "\". Detect Windows absolute
    // paths so we can preserve the drive letter when truncating;
    // otherwise the user sees ".../foo/bar" with no indication of
    // which drive it lived on.
    const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(p);
    const sep = isWindowsAbs ? "\\" : "/";
    const parts = p.split(/[\\/]+/).filter(Boolean);
    if (parts.length <= 3) return p;
    if (isWindowsAbs) {
      // parts[0] is the drive ("C:"); keep it pinned.
      return parts[0] + sep + "..." + sep + parts.slice(-3).join(sep);
    }
    return "..." + sep + parts.slice(-3).join(sep);
  }

  function renderProviderBreakdownCard(summary, totalCost) {
    const providers = ["claude-code", "codex"]
      .map((provider) => [provider, summary?.[provider] || null])
      .filter(([, stat]) => !!stat);
    if (providers.length === 0) {
      return `<div class="detail-empty">${t("No provider-level data yet.")}</div>`;
    }
    return providers.map(([provider, stat]) => `
      <div class="provider-breakdown-row">
        <span class="provider-breakdown-label">
          ${renderProviderBadges([provider], false)}
        </span>
        <span>
          $${fmt(stat.cost, 2)}
          <span class="provider-breakdown-share">${totalCost > 0 ? `(${(stat.cost / totalCost * 100).toFixed(1)}%)` : ""}</span>
        </span>
      </div>
    `).join("");
  }

  function renderProjectToolShare(breakdown) {
    const claudeCost = breakdown?.["claude-code"]?.cost || 0;
    const codexCost = breakdown?.codex?.cost || 0;
    const totalCost = claudeCost + codexCost;
    if (totalCost <= 0) return "";

    const claudeShare = (claudeCost / totalCost) * 100;
    const codexShare = (codexCost / totalCost) * 100;

    return `
      <div class="tool-share-wrap" aria-label="${t("Project cost share by tool")}">
        <div class="tool-share-bar">
          ${claudeCost > 0 ? `<div class="tool-share-segment tool-share-claude" style="width:${claudeShare.toFixed(1)}%"></div>` : ""}
          ${codexCost > 0 ? `<div class="tool-share-segment tool-share-codex" style="width:${codexShare.toFixed(1)}%"></div>` : ""}
        </div>
        <div class="tool-share-meta">
          ${claudeCost > 0 ? `<span class="tool-share-chip tool-share-chip-claude">Claude ${claudeShare.toFixed(0)}%</span>` : ""}
          ${codexCost > 0 ? `<span class="tool-share-chip tool-share-chip-codex">Codex ${codexShare.toFixed(0)}%</span>` : ""}
        </div>
      </div>
    `;
  }

  function renderQuotaCard(quota) {
    if (!quota) {
      return `
        <div class="card">
          <div class="label">${t("Quota")}</div>
          <div class="value" style="font-size:18px;">${t("Unavailable")}</div>
          <div class="meta">${t("No Codex quota snapshot found yet.")}</div>
        </div>
      `;
    }

    const progress = Math.max(0, Math.min(100, quota.usedPercent || 0));
    const tone = progress >= 85 ? "quota-danger" : progress >= 50 ? "quota-warn" : "quota-good";
    const resetAt = new Date(quota.resetsAt);
    const sampledAt = new Date(quota.sampledAt);
    const resetLabel = quota.isCurrentWindow
      ? t("Resets {0}", formatRelativeTime(resetAt))
      : t("Last seen {0}", formatRelativeTime(sampledAt));
    const projection = quota.projectedExhaustsAt
      ? t("At current rate you'll hit the limit around {0}", formatDateTime(quota.projectedExhaustsAt))
      : quota.activeDays7d >= 3 && quota.avgDailyTokens7d > 0
        ? t("Current pace stays within this window.")
        : t("Projection hidden until 3 active days of recent usage.");

    return `
      <div class="card">
        <div class="label">${t("Quota")}</div>
        <div class="value">${progress.toFixed(1)}%</div>
        <div class="meta">${resetLabel} · ${formatDateTime(quota.resetsAt)} <span class="inline-pill">${t("Plan: {0}", formatPlanType(quota.planType))}</span> <span class="inline-pill">${t("OpenAI")}</span></div>
        <div class="quota-progress">
          <div class="quota-progress-bar ${tone}" style="width:${progress.toFixed(1)}%"></div>
        </div>
        <div class="quota-stats">
          <div class="quota-stat-row">
            <span>${t("Last 7 days avg")}</span>
            <span>${fmtTokens(quota.avgDailyTokens7d)}${t("/active day")} <span class="inline-pill">${t("Local logs")}</span></span>
          </div>
          <div class="quota-stat-row">
            <span>${t("Current window usage")}</span>
            <span>${fmtTokens(quota.windowTokensUsed)} <span class="inline-pill">${t("Local logs")}</span></span>
          </div>
          <div class="quota-stat-row">
            <span>${t("Projection")}</span>
            <span>${escapeHtml(projection)}</span>
          </div>
        </div>
        <div class="meta">${t("Projection is based on local Codex logs and may undercount if older sessions were pruned or recorded on another machine.")}</div>
      </div>
    `;
  }

  function renderRateLimitsSection(quota) {
    if (!quota) return "";
    return `
      <div class="section">
        <h2>${t("Rate Limits")}</h2>
        <div class="rate-limit-grid">
          <div class="rate-limit-card">
            <h3>${t("Weekly Window")}</h3>
            <div class="rate-limit-value">${quota.usedPercent.toFixed(1)}%</div>
            <div class="rate-limit-meta">
              ${t("OpenAI service-reported usage")}<br/>
              ${escapeHtml(formatDateTime(quota.windowStart))} ${t("to")} ${escapeHtml(formatDateTime(quota.resetsAt))}<br/>
              ${t("{0} used in current window from local logs", fmtTokens(quota.windowTokensUsed))}
            </div>
          </div>
          <div class="rate-limit-card">
            <h3>${t("Last 7 Days Avg")}</h3>
            <div class="rate-limit-value">${fmtTokens(quota.avgDailyTokens7d)}</div>
            <div class="rate-limit-meta">
              ${t("Per active day from local logs")} · ${tn("{0} active day", "{0} active days", quota.activeDays7d, quota.activeDays7d)} ${t("in sample")}
            </div>
          </div>
          <div class="rate-limit-card">
            <h3>${t("Projected Exhaust")}</h3>
            <div class="rate-limit-value">${quota.projectedExhaustsAt ? escapeHtml(formatDateTime(quota.projectedExhaustsAt)) : "—"}</div>
            <div class="rate-limit-meta">
              ${quota.projectedExhaustsAt
                ? t("At current local pace, the limit is projected to be exhausted {0}.", formatRelativeTime(quota.projectedExhaustsAt))
                : quota.activeDays7d >= 3
                  ? t("Current local pace does not project an exhaustion before the reset.")
                  : t("Need at least 3 active days in recent local logs to project exhaustion.")}
            </div>
          </div>
          <div class="rate-limit-card">
            <h3>${t("Limit Hits")}</h3>
            <div class="rate-limit-value">${quota.recentLimitExceededCount}</div>
            <div class="rate-limit-meta">
              ${quota.mostRecentLimitExceededAt
                ? t("Most recent: {0}", formatDateTime(quota.mostRecentLimitExceededAt))
                : t("No usage_limit_exceeded events in the current window.")}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderEmptyState(range, provider, rootStatus) {
    if (provider === "claude-code" && !rootStatus["claude-code"]) {
      return rootStatus.codex
        ? t("No Claude Code logs found. Switch to All Tools or Codex.")
        : t("No Claude Code logs found in the default local Claude log directory.");
    }
    if (provider === "codex" && !rootStatus.codex) {
      return rootStatus["claude-code"]
        ? t("No Codex logs found. Switch to All Tools or Claude Code.")
        : t("No Codex logs found in the default local Codex log directory.");
    }
    if (provider === "codex") {
      return range === "all"
        ? t("Codex has no recorded token usage yet. Use Codex, then refresh.")
        : t("Codex has no data in this range. Try All Time or switch to All Tools.");
    }
    if (provider === "claude-code") {
      return range === "all"
        ? t("Claude Code has no recorded assistant turns yet. Use Claude Code, then refresh.")
        : t("Claude Code has no data in this range. Try All Time.");
    }
    return range === "all"
      ? t("No assistant turns recorded yet. Use Claude Code or Codex, then refresh.")
      : t("No usage data in this range. Try All Time.");
  }

  function normalizeProvider(provider) {
    return provider === "claude-code" || provider === "codex" ? provider : "all";
  }

  function extractProviderIds(breakdown) {
    if (!breakdown) return [];
    return Object.keys(breakdown).filter((provider) => provider === "claude-code" || provider === "codex");
  }

  function renderProviderBadges(providers, wrap = true) {
    const badges = (providers || [])
      .filter((provider, index, array) => (provider === "claude-code" || provider === "codex") && array.indexOf(provider) === index)
      .map((provider) => `<span class="provider-badge provider-${provider}">${escapeHtml(providerLabel(provider))}</span>`)
      .join("");
    if (!badges) return "";
    return wrap ? `<span class="provider-badges">${badges}</span>` : badges;
  }

  function providerLabel(provider) {
    return provider === "claude-code" ? t("Claude") : provider === "codex" ? t("Codex") : t("All Tools");
  }

  function formatPlanType(planType) {
    if (!planType) return t("Unknown");
    return String(planType).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mi = String(date.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function formatRelativeTime(target) {
    const date = target instanceof Date ? target : new Date(target);
    if (Number.isNaN(date.getTime())) return t("soon");
    const diffMs = date.getTime() - Date.now();
    const absMs = Math.abs(diffMs);
    const totalHours = Math.floor(absMs / (60 * 60 * 1000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const base = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
    return diffMs >= 0 ? t("in {0}", base) : t("{0} ago", base);
  }

  function rangeLabel(r) {
    return r === "today" ? t("Today") : r === "month" ? t("This Month") : t("All Time");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
