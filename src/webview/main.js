(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById("content");
  const generatedAt = document.getElementById("generatedAt");
  const state = {
    metric: "tokens",
    selectedMonth: null,
    payload: null,
    lastRequestId: 0,
    lastHoverKey: "",
  };

  document.querySelectorAll(".pill").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".pill").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      vscode.postMessage({ type: "setRange", range: b.dataset.range });
      content.innerHTML = `<div class="empty">Loading…</div>`;
    });
  });

  document.getElementById("refreshBtn").addEventListener("click", () => {
    const active = document.querySelector(".pill.active");
    vscode.postMessage({ type: "setRange", range: active.dataset.range });
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "data") {
      const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
      if (requestId && requestId < state.lastRequestId) return;
      if (requestId) state.lastRequestId = requestId;
      state.payload = msg;
      syncState();
      try {
        renderCurrent();
      } catch (err) {
        content.innerHTML = `<div class="empty">Render error: ${escapeHtml(err?.message || String(err))}</div>`;
      }
    } else if (msg.type === "error") {
      const requestId = typeof msg.requestId === "number" ? msg.requestId : 0;
      if (requestId && requestId < state.lastRequestId) return;
      content.innerHTML = `<div class="empty">Error: ${escapeHtml(msg.message)}</div>`;
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
    if (!label || !meta || !models || !state.payload) return;
    const hoverKey = `${dataset.hoverScope || ""}:${dataset.hoverBucket || ""}`;
    if (hoverKey && hoverKey === state.lastHoverKey) return;
    state.lastHoverKey = hoverKey;
    label.textContent = dataset.hoverLabel || "Hover a cell";
    meta.textContent = `Spend ${dataset.hoverSpend || "$0.00"} · Usage ${dataset.hoverTokens || "0"}`;
    models.innerHTML = renderHoverModels(dataset.hoverBucket || "", dataset.hoverScope || "");
  }

  vscode.postMessage({ type: "ready" });

  function syncState() {
    if (!state.payload) return;
    const { result, range } = state.payload;
    const months = buildAvailableMonths(result);

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

    if (!state.selectedMonth || !months.includes(state.selectedMonth)) {
      state.selectedMonth = months[months.length - 1];
    }
  }

  function renderCurrent() {
    if (!state.payload) return;
    const { result, range, rootExists, pricingMeta } = state.payload;
    render(result, range, rootExists, pricingMeta);
  }

  function render(result, range, rootExists, pricingMeta) {
    if (!rootExists) {
      content.innerHTML = `<div class="empty">No Claude Code logs found at <code>~/.claude/projects</code>. Use Claude Code at least once to generate logs.</div>`;
      return;
    }
    if (result.totals.messages === 0) {
      content.innerHTML = `<div class="empty">No usage data in this range. Try "All Time".</div>`;
      generatedAt.textContent = `Scanned ${result.scannedFiles} session files · no messages in range`;
      return;
    }

    generatedAt.textContent = `Scanned ${result.scannedFiles} session files · updated ${new Date(result.generatedAt).toLocaleTimeString()}`;

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

    content.innerHTML = `
      ${renderPricingBanner(pricingMeta, unknown)}

      <div class="cards">
          <div class="card">
          <div class="label">Total Spend (${rangeLabel(range)})</div>
          <div class="value">$${fmt(totals.cost, 2)}</div>
          <div class="meta">${totals.messages.toLocaleString()} assistant turns · ${totals.sessions} sessions${totals.syntheticMessages ? ` · ${totals.syntheticMessages} synthetic excluded` : ""}${totals.unknownMessages ? ` · <span class="warn">${totals.unknownMessages} with unknown pricing</span>` : ""}</div>
        </div>
        <div class="card">
          <div class="label">Tokens Used</div>
          <div class="value">${fmtTokens(totalTokens)}</div>
          <div class="meta">Cache reuse: ${hitRate.toFixed(1)}%</div>
        </div>
        <div class="card">
          <div class="label">Top Project</div>
          <div class="value" style="font-size:18px; word-break:break-all;">${escapeHtml(shortPath(topProjects[0]?.project || "—"))}</div>
          <div class="meta">$${fmt(topProjects[0]?.cost || 0, 2)} · ${topProjects[0]?.sessions || 0} sessions</div>
        </div>
      </div>

      ${renderHeatmapSection(result, range)}

      <div class="section">
        <h2>Projects</h2>
        <div>
          ${topProjects.map((p) => `
            <div class="project-row">
              <div>
                <div class="project-name" title="${escapeHtml(p.project)}">${escapeHtml(shortPath(p.project))}${p.unknownTokens > 0 ? ' <span class="warn-pill" title="Includes tokens from models with unknown pricing">⚠</span>' : ""}</div>
                <div class="bar-wrap" style="margin-top:6px;"><div class="bar" style="width:${(p.cost / maxProjCost * 100).toFixed(1)}%"></div></div>
              </div>
              <div class="project-cost">$${fmt(p.cost, 2)}</div>
              <div class="project-meta">${p.sessions} sess<br/>${fmtTokens(p.inTokens + p.outTokens + p.cacheRead + p.cacheWrite)}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div class="section">
        <h2>By Model</h2>
        <div>
          ${models.map(([m, s]) => `
            <div class="model-row">
              <span class="name">${escapeHtml(m)}${s.isKnown ? "" : ' <span class="warn-pill" title="No pricing match — counted as $0">⚠ unpriced</span>'}</span>
              <span>${s.isKnown ? "$" + fmt(s.cost, 2) + " · " : ""}${fmtTokens(s.tokens)} · ${s.messages} turns${s.isKnown && totals.cost > 0 ? ` (${(s.cost / totals.cost * 100).toFixed(1)}%)` : ""}</span>
            </div>
          `).join("")}
        </div>
      </div>

      ${(pricedSpikes.length || unpricedSpikes.length) ? `
        <div class="section">
          <h2>Spike Turns</h2>
          <div class="section-meta">Priced spikes: &gt;$${fmt(pricingMeta?.spikeThreshold || 1, 2)} per turn · Unpriced spikes: token-based (high token volume)</div>
          <div class="alerts">
            ${pricedSpikes.slice(0, 10).map((s) => `
              <div class="alert-row">
                <span class="cost">$${fmt(s.cost, 2)}</span>
                · ${escapeHtml(fmtTokens(s.tokens))} tokens
                · ${escapeHtml(shortPath(s.project))}
                · ${escapeHtml(s.model)}
                · ${escapeHtml(formatSpikeTimestamp(s.ts))}
              </div>
            `).join("")}
            ${unpricedSpikes.length ? `<div class="alert-subhead">High token volume (unpriced models)</div>` : ""}
            ${unpricedSpikes.slice(0, 10).map((s) => `
              <div class="alert-row">
                <span class="cost">${escapeHtml(fmtTokens(s.tokens))} tokens</span>
                · ${escapeHtml(shortPath(s.project))}
                · ${escapeHtml(s.model)} <span class="warn-pill" title="No pricing match — spike is token-based">unpriced</span>
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
    const title = range === "today" ? "Hourly Heatmap" : "Calendar Heatmap";
    const controls = `
      <div class="segmented">
        <button class="seg-btn ${currentMetric === "cost" ? "active" : ""}" data-action="setMetric" data-metric="cost">Spend</button>
        <button class="seg-btn ${currentMetric === "tokens" ? "active" : ""}" data-action="setMetric" data-metric="tokens">Usage</button>
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
        ${range === "today" ? renderHourlyHeatmap(result, currentMetric) : renderMonthlyHeatmap(result, selectedMonth, currentMetric)}
      </div>
    `;
  }

  function renderAllTimeOverview(result, selectedMonth, metric) {
    const months = buildAvailableMonths(result);
    if (months.length === 0) return "";
    return `
      <div class="heatmap-overview-grid">
        ${months.map((month) => renderMiniMonthCard(result, month, metric, month === selectedMonth)).join("")}
      </div>
    `;
  }

  function renderMiniMonthCard(result, monthKey, metric, isActive) {
    const calendar = buildMonthCalendar(monthKey);
    const values = metric === "tokens" ? (result.byDayTokens || {}) : (result.byDay || {});
    const monthValues = Array.from({ length: calendar.daysInMonth }, (_, index) => values[dayKey(monthKey, index + 1)] || 0);
    const maxValue = Math.max(...monthValues, 0);
    const cells = calendar.slots.map((slot) => {
      if (!slot.day) return `<div class="heatmap-cell empty"></div>`;
      const key = dayKey(monthKey, slot.day);
      const value = values[key] || 0;
      return `<div class="heatmap-cell active" style="background:${heatColor(value, maxValue)}"></div>`;
    }).join("");
    return `
      <div class="mini-month ${isActive ? "active" : ""}" data-action="selectMonth" data-month="${monthKey}" role="button" tabindex="0" aria-pressed="${isActive ? "true" : "false"}" aria-label="Show ${escapeHtml(formatMonthLabel(monthKey))}">
        <div class="mini-month-title">${escapeHtml(formatMonthLabel(monthKey))}</div>
        <div class="mini-month-grid">${cells}</div>
      </div>
    `;
  }

  function renderHourlyHeatmap(result, metric) {
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
      ? "No activity yet today."
      : "Move over a square to inspect the exact bucket.";
    return `
      <div class="heatmap-detail-layout">
        <div class="heatmap-shell">
          <div class="large-hours-grid">${cells}</div>
          ${renderLegend(metric)}
        </div>
        ${renderDetailCard(`Today (${day})`, summary.scopeMeta, "Hover an hour", hoverMeta)}
      </div>
    `;
  }

  function renderMonthlyHeatmap(result, monthKey, metric) {
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
    const weekdayHead = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
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
        ${renderDetailCard(formatMonthLabel(month), summary.scopeMeta, "Hover a day", "Move over a square to inspect the exact date.")}
      </div>
    `;
  }

  function renderLegend(metric) {
    const palette = [0, 1, 2, 3, 4].map((level) => `
      <span class="legend-chip" style="background:${heatColor(level, 4)}"></span>
    `).join("");
    return `
      <div class="heatmap-legend">
        <span>${metric === "tokens" ? "Usage volume by token count" : "Spend intensity by cost"}</span>
        <div class="legend-scale">
          <span>Less</span>
          ${palette}
          <span>More</span>
        </div>
      </div>
    `;
  }

  function renderDetailCard(scopeTitle, scopeMeta, hoverLabel, hoverMeta) {
    return `
      <div class="detail-card">
        <div class="detail-block">
          <div class="detail-label">Scope</div>
          <div class="detail-value">${escapeHtml(scopeTitle)}</div>
          <div class="detail-meta">${escapeHtml(scopeMeta)}</div>
        </div>
        <div class="detail-block">
          <div class="detail-label">Hover</div>
          <div class="detail-value" id="heatmap-hover-label">${escapeHtml(hoverLabel)}</div>
          <div class="detail-meta" id="heatmap-hover-meta">${escapeHtml(hoverMeta)}</div>
          <div class="detail-models" id="heatmap-hover-models">
            <div class="detail-empty">Hover a cell to see model breakdown.</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderPricingBanner(meta, unknown) {
    if (!meta) return "";
    const bits = [];
    if (meta.customCount) bits.push(`<b>${meta.customCount}</b> custom`);
    bits.push(`<b>${meta.builtinCount || 0}</b> built-in`);

    let banner = `<div class="pricing-meta">Pricing sources: ${bits.join(" · ")} · <a href="#" data-action="openSettings">configure</a></div>`;

    if (unknown.length > 0) {
      banner += `<div class="warn-banner">
        ⚠ ${unknown.length} model${unknown.length > 1 ? "s" : ""} have no pricing match and are counted as $0:
        <code>${unknown.map(escapeHtml).join("</code>, <code>")}</code>.
        Add them via <a href="#" data-action="openSettings">customPricing</a>.
      </div>`;
    }
    return banner;
  }

  function buildAvailableMonths(result) {
    const months = new Set();
    const dayKeys = Object.keys(result.byDay || {});
    const tokenKeys = Object.keys(result.byDayTokens || {});
    for (const day of [...dayKeys, ...tokenKeys]) months.add(day.slice(0, 7));
    return Array.from(months).sort();
  }

  function buildTooltip(label, spend, tokens) {
    return `${label}\nSpend: $${fmt(spend, 4)}\nUsage: ${fmtTokens(tokens)}`;
  }

  function renderHoverModels(bucketKey, scope) {
    if (!state.payload || !bucketKey || !scope) {
      return `<div class="detail-empty">Hover a cell to see model breakdown.</div>`;
    }
    const result = state.payload.result;
    const models = scope === "hour"
      ? (result.byHourModels?.[bucketKey] || {})
      : (result.byDayModels?.[bucketKey] || {});
    const entries = Object.entries(models).sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens);
    if (entries.length === 0) {
      return `<div class="detail-empty">No model-level data in this bucket.</div>`;
    }
    return entries.map(([model, stat]) => `
      <div class="detail-model-row">
        <div class="detail-model-name" title="${escapeHtml(model)}">
          ${escapeHtml(model)}${stat.isKnown ? "" : ' <span class="detail-model-badge">unpriced</span>'}
        </div>
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
      scopeMeta: `$${fmt(spend, 2)} · ${fmtTokens(tokens)} · ${activeDays} active day${activeDays === 1 ? "" : "s"}`,
    };
  }

  function summarizeHours(hours) {
    const spend = hours.reduce((sum, hour) => sum + hour.spend, 0);
    const tokens = hours.reduce((sum, hour) => sum + hour.tokens, 0);
    const activeHours = hours.filter((hour) => hour.tokens > 0).length;
    return {
      scopeMeta: `$${fmt(spend, 2)} · ${fmtTokens(tokens)} · ${activeHours} active hour${activeHours === 1 ? "" : "s"}`,
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

  function rangeLabel(r) {
    return r === "today" ? "Today" : r === "month" ? "This Month" : "All Time";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
