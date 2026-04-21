(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById("content");
  const generatedAt = document.getElementById("generatedAt");

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
    if (msg.type === "data") render(msg.result, msg.range, msg.rootExists, msg.pricingMeta);
    else if (msg.type === "error") {
      content.innerHTML = `<div class="empty">Error: ${escapeHtml(msg.message)}</div>`;
    }
  });

  // Delegated click handler for "open settings" links.
  document.body.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.action === "openSettings") {
      e.preventDefault();
      vscode.postMessage({ type: "openSettings" });
    }
  });

  vscode.postMessage({ type: "ready" });

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

    const days = Object.entries(result.byDay).sort(([a], [b]) => a.localeCompare(b));
    const maxDay = Math.max(...days.map(([, v]) => v), 0.0001);

    const models = Object.entries(result.byModel).sort(([, a], [, b]) => b.cost - a.cost);
    const spikes = result.spikes || [];
    const unknown = result.unknownModels || [];

    content.innerHTML = `
      ${renderPricingBanner(pricingMeta, unknown)}

      <div class="cards">
        <div class="card">
          <div class="label">Total Spend (${rangeLabel(range)})</div>
          <div class="value">$${fmt(totals.cost, 2)}</div>
          <div class="meta">${totals.messages.toLocaleString()} assistant turns · ${totals.sessions} sessions${totals.unknownMessages ? ` · <span class="warn">${totals.unknownMessages} with unknown pricing</span>` : ""}</div>
        </div>
        <div class="card">
          <div class="label">Tokens Used</div>
          <div class="value">${fmtTokens(totalTokens)}</div>
          <div class="meta">Cache hit rate: ${hitRate.toFixed(1)}%</div>
        </div>
        <div class="card">
          <div class="label">Top Project</div>
          <div class="value" style="font-size:18px; word-break:break-all;">${escapeHtml(shortPath(topProjects[0]?.project || "—"))}</div>
          <div class="meta">$${fmt(topProjects[0]?.cost || 0, 2)} · ${topProjects[0]?.sessions || 0} sessions</div>
        </div>
      </div>

      <div class="section">
        <h2>Daily Spend</h2>
        <div class="chart">${renderBarChart(days, maxDay)}</div>
      </div>

      <div class="section">
        <h2>Projects</h2>
        <div>
          ${topProjects.map(p => `
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

      ${spikes.length ? `
        <div class="section">
          <h2>Cost Spikes (>$1 per turn)</h2>
          <div class="alerts">
            ${spikes.slice(0, 10).map(s => `
              <div class="alert-row">
                <span class="cost">$${fmt(s.cost, 2)}</span>
                · ${escapeHtml(shortPath(s.project))}
                · ${escapeHtml(s.model)}
                · ${escapeHtml((s.ts || "").replace("T", " ").slice(0, 16))}
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}
    `;
  }

  function renderPricingBanner(meta, unknown) {
    if (!meta) return "";
    const bits = [];
    if (meta.customCount) bits.push(`<b>${meta.customCount}</b> custom`);
    if (meta.remoteCount) {
      const when = meta.remoteFetchedAt ? new Date(meta.remoteFetchedAt).toLocaleTimeString() : "?";
      const tag = meta.remoteSource === "fresh" ? "fresh" : meta.remoteSource === "cache" ? "cached" : meta.remoteSource === "stale-cache" ? "stale (offline)" : "empty";
      bits.push(`<b>${meta.remoteCount}</b> remote (${tag}, ${when})`);
    }
    if (meta.remoteUrl && meta.remoteCount === 0 && meta.remoteError) {
      bits.push(`<span class="warn">remote fetch failed: ${escapeHtml(meta.remoteError)}</span>`);
    }
    bits.push(`<b>5</b> built-in`);

    let banner = `<div class="pricing-meta">Pricing sources: ${bits.join(" · ")} · <a href="#" data-action="openSettings">configure</a></div>`;

    if (unknown.length > 0) {
      banner += `<div class="warn-banner">
        ⚠ ${unknown.length} model${unknown.length > 1 ? "s" : ""} have no pricing match and are counted as $0:
        <code>${unknown.map(escapeHtml).join("</code>, <code>")}</code>.
        Add them via <a href="#" data-action="openSettings">customPricing</a>${meta.useCommunity || meta.remoteUrl ? "" : ', or enable <a href="#" data-action="openSettings">community pricing</a>'}.
      </div>`;
    }
    return banner;
  }

  function renderBarChart(days, maxVal) {
    if (days.length === 0) return `<div class="empty" style="padding:20px;">No daily data.</div>`;
    const w = 800, h = 130, pad = 20;
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    const barW = Math.max(2, innerW / days.length - 2);
    const bars = days.map(([day, v], i) => {
      const x = pad + i * (innerW / days.length);
      const bh = (v / maxVal) * innerH;
      const y = h - pad - bh;
      const isSpike = v > maxVal * 0.85;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"
        fill="${isSpike ? "var(--danger)" : "var(--accent)"}" opacity="0.85">
        <title>${day}: $${v.toFixed(2)}</title></rect>`;
    }).join("");
    const firstLabel = days[0][0].slice(5);
    const lastLabel = days[days.length - 1][0].slice(5);
    return `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:100%;">
        ${bars}
        <text x="${pad}" y="${h - 4}" font-size="10" fill="var(--muted)">${firstLabel}</text>
        <text x="${w - pad - 30}" y="${h - 4}" font-size="10" fill="var(--muted)">${lastLabel}</text>
        <text x="${pad}" y="12" font-size="10" fill="var(--muted)">$${maxVal.toFixed(2)}</text>
      </svg>`;
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
    const parts = p.split("/").filter(Boolean);
    if (parts.length <= 3) return p;
    return ".../" + parts.slice(-3).join("/");
  }
  function rangeLabel(r) { return r === "today" ? "Today" : r === "month" ? "This Month" : "All Time"; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
