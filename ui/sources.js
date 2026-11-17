/* ORBIT — Sources page.
   Where the evidence comes from (mission history) and the power model learned from it.
   Classic script, loaded before app.js; shares its globals ($, state, escapeHtml, apiUrl, fmt…). */

const SRC_DAY_MS = 86400000;

const MISS_WHY = {
  sunrise: "Solar current jumped mid-step as the spacecraft left eclipse. The model doesn't forecast orbit lighting yet.",
  fault: "The load drew far more than its learned healthy amount: a fault. History can't foresee that, so on a live case ORBIT uses the measured current once the load is on.",
  other: "The load changed as expected, but the voltage didn't follow. Possibly the charger tapering near full.",
};

function srcDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function srcWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function srcHistoryClock(t, start) {
  const d = new Date(Date.parse(start) + t * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";
}

function srcNum(n, digits = 0) {
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function loadSources() {
  state.sourcesLoading = true;
  renderSources();
  try {
    const [res] = await Promise.all([fetch(apiUrl("/sources")), loadHistoryAlarms(true)]);
    if (!res.ok) throw new Error(`sources ${res.status}`);
    state.sourcesData = await res.json();
    state.sourcesError = null;
  } catch (err) {
    state.sourcesError = err.message;
  } finally {
    state.sourcesLoading = false;
    renderSources();
  }
}

async function calibrateModel() {
  if (state.calibrating) return;
  state.calibrating = true;
  renderSources();
  try {
    const res = await fetch(apiUrl("/model/calibrate"), { method: "POST" });
    if (!res.ok) throw new Error(`calibrate ${res.status}`);
    await res.json();
    state.justCalibrated = true;
    await loadSources();  // refresh everything that depends on the model (stale flag, badges)
    announceLive("Power model re-learned from history.");
  } catch (err) {
    window.alert(`Could not learn the model.\n\n${err.message}`);
  } finally {
    state.calibrating = false;
    renderSources();
  }
}

function renderSources() {
  const root = $("sources-desk");
  if (!root) return;
  const d = state.sourcesData;
  if (!d) {
    root.innerHTML = `<div class="src-loading">${state.sourcesError ? `Couldn't load sources: ${escapeHtml(state.sourcesError)}` : "Reading mission history…"}</div>`;
    return;
  }
  const m = d.model;
  const ready = !!m;
  root.innerHTML = `
    <header class="src-head">
      <div>
        <p class="src-kicker"><span class="live-dot" aria-hidden="true"></span>Aurora-1 · setup</p>
        <h1>Sources</h1>
        <p class="src-sub">Where ORBIT's evidence comes from, and how far its power model can be trusted.</p>
      </div>
      <div class="src-unlocks" aria-label="What works now">
        ${srcUnlock(true, "Evidence & explanations", "From connected history")}
        ${srcUnlock(ready && !d.model_stale ? true : "partial", "Fix previews", !ready ? "Datasheet values only" : d.model_stale ? "Re-learn for the new source" : "Model learned from history")}
      </div>
    </header>
    ${state.cx ? renderConnect() : renderHistoryCard(d.history)}
    ${renderModelCard(d, m)}`;
  state.justConnected = false;
}

function srcUnlock(on, title, sub) {
  const cls = on === true ? "on" : on === "partial" ? "partial" : "off";
  const icon = on === true ? "✓" : on === "partial" ? "◐" : "○";
  return `<div class="src-unlock ${cls}"><span class="ic">${icon}</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(sub)}</small></span></div>`;
}

/* ── History card ─────────────────────────────────────────────── */

function renderHistoryCard(h) {
  const issues = [];
  if (h.gaps.count) issues.push(`<li><span class="dot warn"></span><span><b>${h.gaps.count} telemetry gaps</b>, ${h.gaps.missing_hours} h missing in total, longest ${Math.round(h.gaps.longest_minutes)} min. Cases that fall in a gap can't be sealed.</span></li>`);
  if (h.glitches) issues.push(`<li><span class="dot warn"></span><span><b>${h.glitches} single-sample glitches</b> on bus voltage. The model reads medians, so they don't skew what it learns.</span></li>`);
  if (h.unmapped.length) issues.push(`<li><span class="dot info"></span><span><b>${h.unmapped.length} commands ORBIT can't interpret</b>: ${h.unmapped.map((c) => `<code>${escapeHtml(c.name)}</code> ×${c.count}`).join(", ")}. They're shown on timelines but ignored by the model.</span></li>`);
  const days = h.per_day.map((c, i) => {
    const tone = c >= 0.999 ? "full" : c >= 0.97 ? "some" : "gap";
    const date = new Date(Date.parse(h.start) + i * SRC_DAY_MS);
    const label = `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}: ${(c * 100).toFixed(1)}% coverage`;
    return `<i class="day ${tone}" title="${escapeHtml(label)}"></i>`;
  }).join("");
  const mapped = h.commands.filter((c) => c.mapped);
  return `
  <section class="src-card">
    <div class="src-card-head">
      <div class="src-title">
        <span class="src-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><ellipse cx="10" cy="4.5" rx="6.5" ry="2.5"/><path d="M3.5 4.5v11c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-11M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5"/></svg></span>
        <div><h2>Mission history</h2><p>${escapeHtml(h.name)} · ${escapeHtml(h.kind)}</p></div>
      </div>
      <div class="src-badges">
        ${h.synthetic ? `<span class="src-badge synthetic" title="Generated with known hidden truth, for testing">Dummy data</span>` : ""}
        <span class="src-badge ok">✓ Connected</span>
        <button type="button" class="btn ${h.source_kind === "postgres" ? "btn-ghost" : ""}" data-src-connect>${h.source_kind === "postgres" ? "Change source" : "Connect a database"}</button>
      </div>
    </div>
    ${h.source_kind === "postgres" ? `
    <div class="src-conn">
      <span><span class="k">Database</span><code>${escapeHtml(h.url || "")}</code></span>
      <span><span class="k">Table</span><code>${escapeHtml(h.table || "")}</code></span>
      <span><span class="k">Read in</span>${h.load_seconds} s</span>
      ${h.scaled.length ? `<span><span class="k">Unit fixes</span>${h.scaled.map((x) => `<code>${escapeHtml(x.source)}</code> × ${x.scale}`).join(", ")}</span>` : ""}
      <button type="button" class="text-btn" data-src-reset>Use dummy CSV instead</button>
    </div>` : ""}
    <div class="src-stats">
      <div><span class="k">Span</span><span class="v">${h.days} days</span><span class="s">${srcDate(h.start)} → ${srcDate(h.end)}</span></div>
      <div><span class="k">Samples</span><span class="v">${srcNum(h.rows)}</span><span class="s">every ${h.sample_interval_s} s · ${h.channels.length} channels</span></div>
      <div><span class="k">Coverage</span><span class="v">${h.coverage_pct}%</span><span class="s">${h.gaps.count} gaps</span></div>
      <div><span class="k">Commands</span><span class="v">${srcNum(h.commands.reduce((s, c) => s + c.count, 0))}</span><span class="s">${mapped.length} kinds mapped · ${h.unmapped.length} not</span></div>
    </div>
    <div class="src-coverage">
      <div class="src-coverage-head"><span>Coverage by day</span><span class="legend"><i class="day full"></i>complete <i class="day some"></i>small gaps <i class="day gap"></i>large gaps</span></div>
      <div class="days">${days}</div>
    </div>
    <div class="src-alarms-wrap">
      <p class="src-label">Alarms in this history <span class="muted">· a channel past its warn for two samples in a row; related alarms grouped</span></p>
      <div id="src-alarms">${historyAlarmRows(state.historyAlarms)}</div>
    </div>
    ${issues.length ? `<div class="src-issues"><p class="src-label">Worth knowing</p><ul>${issues.join("")}</ul></div>` : ""}
    <details class="src-more">
      <summary>Command mapping</summary>
      <table class="src-table">
        <thead><tr><th>Command</th><th>What ORBIT thinks it does</th><th class="num">In history</th></tr></thead>
        <tbody>${h.commands.map((c) => `<tr class="${c.mapped ? "" : "unmapped"}"><td><code>${escapeHtml(c.name)}</code></td><td>${c.mapped ? escapeHtml(c.meaning) : '<span class="muted">Not mapped, so ignored by the model</span>'}</td><td class="num">${c.count}</td></tr>`).join("")}</tbody>
      </table>
    </details>
  </section>`;
}

/* ── Model card ───────────────────────────────────────────────── */

function renderModelCard(d, m) {
  const labels = d.param_labels;
  const busy = state.calibrating;
  const btn = `<button type="button" class="btn ${m && !d.model_stale ? "btn-ghost" : ""}" id="src-calibrate" ${busy ? "disabled" : ""}>${busy ? "Learning from history…" : m ? "Re-learn from history" : "Learn from history"}</button>`;
  const head = `
    <div class="src-card-head">
      <div class="src-title">
        <span class="src-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M11 2 4 11h5l-1 7 7-9h-5z"/></svg></span>
        <div><h2>Power model</h2><p>Physics from the spec, numbers learned from this spacecraft's history</p></div>
      </div>
      <div class="src-badges">${!m ? `<span class="src-badge partial">◐ Datasheet values only</span>` : d.model_stale ? `<span class="src-badge partial">◐ Re-learn needed</span>` : `<span class="src-badge ok">✓ Ready for previews</span>`}${btn}</div>
    </div>`;
  if (!m) {
    const rows = Object.entries(d.prior).map(([k, v]) => `<tr><td>${escapeHtml(labels[k].label)}</td><td class="num">${v} ${escapeHtml(labels[k].unit)}</td><td class="muted">not learned yet</td></tr>`).join("");
    return `<section class="src-card ${busy ? "is-busy" : ""}">${head}
      <div class="src-empty">
        <p><b>Fix previews are using datasheet values.</b> They can be off by a few tenths of a volt, so case pages mark them as medium confidence at best.</p>
        <p class="muted">Learning reads the command steps in the history (a heater switching on is a clean ΔV/ΔI experiment), fits the model, then tests it on the most recent days it didn't see.</p>
      </div>
      <table class="src-table"><thead><tr><th>Parameter</th><th class="num">Datasheet</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }

  const paramRows = Object.entries(m.params).map(([k, v]) => {
    const prior = m.prior[k];
    const pct = prior ? ((v - prior) / prior) * 100 : 0;
    const big = Math.abs(pct) >= 10;
    const change = Math.abs(pct) < 0.5 ? `<span class="muted">same</span>` : `<span class="chg ${big ? "big" : ""}">${pct > 0 ? "+" : ""}${pct.toFixed(0)}%</span>`;
    return `<tr><td>${escapeHtml(labels[k].label)}</td><td class="num muted">${prior} ${escapeHtml(labels[k].unit)}</td><td class="num strong">${v} ${escapeHtml(labels[k].unit)}</td><td class="num">${change}</td></tr>`;
  }).join("");

  const wear = m.wear || [];
  const wmax = Math.max(...wear.map((w) => w.battery_ohm), 0.0001);
  const wmin = Math.min(...wear.map((w) => w.battery_ohm));
  const wearHtml = wear.length ? `
    <div class="src-wear">
      <p class="src-label">Battery resistance by week</p>
      <div class="bars">${wear.map((w) => `<div class="bar" title="${w.n} steps"><span style="height:${Math.round(30 + 70 * (w.battery_ohm - wmin * 0.95) / (wmax - wmin * 0.95))}%"></span><b>${w.battery_ohm.toFixed(3)}</b><small>wk ${w.week}</small></div>`).join("")}</div>
      <p class="muted small">Measured at each command step. Rising resistance means an aging pack; week to week the estimate is noisy.</p>
    </div>` : "";

  const bt = m.backtest;
  const chRows = Object.values(bt.channels).map((c) => {
    const pct = c.total ? (100 * c.hits) / c.total : 0;
    const tone = pct >= 90 ? "ok" : pct >= 75 ? "warn" : "bad";
    return `<div class="src-score">
      <div class="src-score-top"><b>${escapeHtml(c.label)}</b><span class="${tone}">${c.hits} of ${c.total} right</span></div>
      <div class="meter"><span class="${tone}" style="width:${pct.toFixed(1)}%"></span></div>
      <small>Within ${bt.tolerance_v} V of what really happened · typical error ${c.mae} V</small>
    </div>`;
  }).join("");

  const kindLabel = { sunrise: "Sunrise during the step", fault: "A fault the model can't foresee", other: "Other" };
  const groups = {};
  for (const miss of bt.misses) (groups[miss.kind] = groups[miss.kind] || []).push(miss);
  const kinds = bt.miss_kinds || {};
  const top = Object.entries(kinds).sort((p, q) => q[1] - p[1])[0];
  const insight = top && top[0] === "sunrise" && top[1] / bt.misses.length >= 0.5
    ? `<p class="src-insight"><b>${top[1]} of ${bt.misses.length} misses happen at sunrise.</b> Teaching the model orbit lighting is the clearest next improvement.</p>` : "";
  const missHtml = bt.misses.length ? insight + `
    <details class="src-more" ${state.openMisses ? "open" : ""} id="src-misses">
      <summary>See the ${bt.misses.length} misses <span class="muted">· ${Object.entries(bt.miss_kinds || {}).map(([k, n]) => `${n} ${escapeHtml(kindLabel[k] || k).toLowerCase()}`).join(" · ")}</span></summary>
      ${Object.entries(groups).map(([kind, list]) => `
        <div class="miss-group">
          <p class="src-label">${escapeHtml(kindLabel[kind] || kind)} · ${list.length}</p>
          <p class="miss-why">${escapeHtml(MISS_WHY[kind] || list[0].why)}</p>
          <table class="src-table compact"><thead><tr><th>When</th><th>Command</th><th class="num">Forecast</th><th class="num">Actual</th><th class="num">Off by</th></tr></thead>
          <tbody>${list.slice(0, 5).map((x) => `<tr><td>${escapeHtml(srcHistoryClock(x.t, d.history.start))}</td><td><code>${escapeHtml(x.command)}</code></td><td class="num">${x["EPS.bus_voltage"].pred > 0 ? "+" : ""}${x["EPS.bus_voltage"].pred.toFixed(2)} V</td><td class="num">${x["EPS.bus_voltage"].actual > 0 ? "+" : ""}${x["EPS.bus_voltage"].actual.toFixed(2)} V</td><td class="num bad">${Math.abs(x["EPS.bus_voltage"].err).toFixed(2)} V</td></tr>`).join("")}</tbody></table>
          ${list.length > 5 ? `<p class="muted small">+ ${list.length - 5} more like these</p>` : ""}
        </div>`).join("")}
    </details>` : "";

  const truth = m.truth_check ? `
    <div class="src-truth">
      <p class="src-label"><span class="src-badge synthetic">Dummy data check</span> Did it learn the right numbers?</p>
      <p class="muted small">This history was generated with hidden values ORBIT never reads. With real data this panel won't exist; it's here to prove the learning works.</p>
      <table class="src-table compact"><thead><tr><th>Parameter</th><th class="num">Learned</th><th class="num">Hidden truth</th><th class="num">Off by</th></tr></thead>
      <tbody>${m.truth_check.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="num">${r.learned} ${escapeHtml(r.unit)}</td><td class="num">${r.truth} ${escapeHtml(r.unit)}</td><td class="num ${r.ok ? "ok" : "bad"}">${r.ok ? "✓ " : "✗ "}${r.error_pct}%</td></tr>`).join("")}</tbody></table>
    </div>` : "";

  return `
  <section class="src-card ${busy ? "is-busy" : ""} ${state.justCalibrated ? "just" : ""}">
    ${head}
    ${d.model_stale ? `<div class="src-stale"><b>Learned from a different source.</b> History now comes from <b>${escapeHtml(d.history.name)}</b>; this model was learned from <b>${escapeHtml(m.source)}</b>. Re-learn so previews reflect the connected spacecraft.</div>` : ""}
    <p class="src-meta">Learned ${escapeHtml(srcWhen(m.calibrated_at))} from ${escapeHtml(m.source)} (${escapeHtml(m.source_kind || "")}), using the first ${m.split.learned_from_days} days (${m.steps_used} command steps). The last ${m.split.tested_on_days} days were held back to test it.</p>
    <div class="src-cols">
      <div>
        <p class="src-step"><span>1</span>What it learned</p>
        <table class="src-table"><thead><tr><th>Parameter</th><th class="num">Datasheet</th><th class="num">Learned</th><th class="num">Change</th></tr></thead><tbody>${paramRows}</tbody></table>
        ${wearHtml}
      </div>
      <div>
        <p class="src-step"><span>2</span>How well it predicts</p>
        <p class="muted small">Every command in the held-back days, forecast before it happened, then compared with what the voltage actually did.</p>
        ${chRows}
        <div class="src-notmodeled"><b>Not modeled:</b> heater temperature, battery temperature. Cases alarming on these get no previews.</div>
        ${missHtml}
      </div>
    </div>
    <div class="src-step3"><p class="src-step"><span>3</span>On every case</p><p class="muted small">Before showing a preview, ORBIT replays the case's own last few minutes. If the model can't reproduce what already happened, the preview is marked low confidence.</p></div>
    ${truth}
  </section>`;
}

function bindSources() {
  $("sources-desk")?.addEventListener("click", (ev) => {
    if (ev.target.closest("#src-calibrate")) calibrateModel();
  });
  $("sources-desk")?.addEventListener("toggle", (ev) => {
    if (ev.target.id === "src-misses") state.openMisses = ev.target.open;
  }, true);
  $("tab-sources")?.addEventListener("click", () => goSources());
  bindConnect();
  bindHistoryAlarms();
}

function enterSources() {
  setView("sources");
  $("stage").scrollTop = 0;
  syncUrl("sources");
  renderSources();
}

async function goSources() {
  enterSources();
  await loadSources();
}

/* ══ Connect flow ═══════════════════════════════════════════════════
   Connect → Telemetry → Channels → Commands → Review. Every step shows
   what ORBIT understood so a person can confirm it before anything is saved. */

const CX_STEPS = ["Connect", "Telemetry", "Channels", "Commands", "Review"];
const CX_REQUIRED = ["EPS.bus_voltage", "EPS.bus_current", "EPS.battery_voltage", "EPS.battery_current",
  "EPS.solar_array_current", "THM.heater_b_current", "PAY.payload_current", "PAY.mode"];
const CX_ORBIT_LABEL = {
  "EPS.bus_voltage": "Bus voltage", "EPS.bus_current": "Bus current", "EPS.battery_voltage": "Battery voltage",
  "EPS.battery_current": "Battery current", "EPS.solar_array_current": "Solar array current",
  "THM.battery_temperature": "Battery temperature", "THM.heater_b_temperature": "Heater B temperature",
  "THM.heater_b_current": "Heater B current", "PAY.power_draw": "Payload power", "PAY.payload_current": "Payload current",
  "PAY.mode": "Payload mode",
};

function cxStart() {
  state.cx = { open: true, step: 0, kind: "postgres", url: "", busy: false, error: null };
  renderSources();
  $("sources-desk").scrollIntoView({ block: "start" });
}

function cxClose() {
  state.cx = null;
  renderSources();
}

async function cxPost(path, body, opts = {}) {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: opts.raw ? { "Content-Type": "text/csv" } : { "Content-Type": "application/json" },
    body: opts.raw ? body : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${path} ${res.status}`);
  return data;
}

async function cxRun(fn) {
  const cx = state.cx;
  cx.busy = true;
  cx.error = null;
  renderSources();
  try {
    await fn(cx);
  } catch (err) {
    cx.error = err.message;
  } finally {
    cx.busy = false;
    renderSources();
  }
}

function cxProbe(extra = {}) {
  const cx = state.cx;
  return { kind: cx.kind, url: cx.url, table: cx.table, layout: cx.layout, time_col: cx.time_col,
    channel_col: cx.channel_col, value_col: cx.value_col, text_col: cx.text_col, ...extra };
}

const cxActions = {
  async test() {
    await cxRun(async (cx) => {
      cx.url = ($("cx-url")?.value || "").trim();
      if (!cx.url) throw new Error("Paste a database URL first.");
      cx.test = await cxPost("/sources/test", { kind: "postgres", url: cx.url });
      if (!cx.test.ok) throw new Error(cx.test.error);
    });
  },
  demo() {
    const cx = state.cx;
    cx.url = state.sourcesData.demo_db.url;
    cx.test = null;
    renderSources();
  },
  async toTelemetry() {
    await cxRun(async (cx) => {
      if (cx.kind === "postgres") {
        cx.table = cx.table || cx.test.guess.telemetry;
        await cxActions._inspect(cx);
      }
      cx.step = 1;
    });
  },
  async _inspect(cx) {
    const ins = await cxPost("/sources/inspect", cxProbe());
    cx.inspect = ins;
    Object.assign(cx, { layout: ins.guess.layout, time_col: ins.guess.time_col, channel_col: ins.guess.channel_col,
      value_col: ins.guess.value_col, text_col: ins.guess.text_col });
  },
  async pickTable(name) {
    await cxRun(async (cx) => { cx.table = name; await cxActions._inspect(cx); });
  },
  async toChannels() {
    await cxRun(async (cx) => {
      const data = await cxPost("/sources/channels", cxProbe());
      cx.stats = data.stats;
      cx.unused = (data.suggestions.find((s) => s.unused) || {}).unused || [];
      cx.map = data.suggestions.filter((s) => s.orbit);
      cx.step = 2;
    });
  },
  async toCommands() {
    await cxRun(async (cx) => {
      if (cx.kind === "postgres") {
        cx.cmdTable = cx.cmdTable || cx.test.guess.commands;
        if (cx.cmdTable) await cxActions._cmdInspect(cx);
      }
      cx.step = 3;
    });
  },
  async _cmdInspect(cx) {
    const ins = await cxPost("/sources/inspect", { kind: "postgres", url: cx.url, table: cx.cmdTable });
    cx.cmdInspect = ins;
    cx.cmdTime = ins.columns.find((c) => c.type.includes("timestamp"))?.name || ins.guess.time_col;
    cx.cmdCol = ins.guess.command_col;
    await cxActions._cmdNames(cx);
  },
  async _cmdNames(cx) {
    if (!cx.cmdCol) return;
    const data = await cxPost("/sources/commands", { kind: cx.kind, url: cx.url, table: cx.cmdTable, command_col: cx.cmdCol });
    cx.cmds = data.commands;
    cx.orbitCmds = data.orbit_commands;
  },
  async pickCmdTable(name) {
    await cxRun(async (cx) => { cx.cmdTable = name || null; cx.cmds = null; if (name) await cxActions._cmdInspect(cx); });
  },
  async pickCmdCol(name) {
    await cxRun(async (cx) => { cx.cmdCol = name; await cxActions._cmdNames(cx); });
  },
  toReview() {
    const cx = state.cx;
    cx.name = cx.name || (cx.kind === "postgres"
      ? `${(cx.url.split("/").pop() || "database").split("?")[0]} · ${cx.table}`
      : "Uploaded CSV history");
    cx.step = 4;
    renderSources();
  },
  async save() {
    await cxRun(async (cx) => {
      cx.name = ($("cx-name")?.value || cx.name).trim();
      const channels = {};
      for (const m of cx.map) if (m.source) channels[m.orbit] = { source: m.source, scale: Number(m.scale || 1) };
      const map = {};
      for (const c of cx.cmds || []) if (c.orbit) map[c.name] = c.orbit;
      const commands = cx.cmdCol ? { table: cx.cmdTable, time_col: cx.cmdTime, command_col: cx.cmdCol, map } : {};
      const data = await cxPost("/sources/save", {
        kind: cx.kind, name: cx.name, url: cx.kind === "postgres" ? cx.url : null, layout: cx.layout, table: cx.table,
        time_col: cx.time_col, channel_col: cx.channel_col, value_col: cx.value_col, text_col: cx.text_col,
        channels, commands, synthetic: !!cx.test?.synthetic,
      });
      state.sourcesData = { ...state.sourcesData, history: data.history };
      state.cx = null;
      state.justConnected = true;
      state.historyAlarms = null;
      await loadSources();
    });
  },
  async reset() {
    if (!window.confirm("Switch back to the generated dummy CSV history? Your database settings will be forgotten.")) return;
    await cxPost("/sources/reset", {});
    state.historyAlarms = null;
    await loadSources();
  },
};

async function cxUpload(role, file) {
  await cxRun(async (cx) => {
    const text = await file.text();
    const info = await cxPost(`/sources/upload?role=${role}`, text, { raw: true });
    cx.uploads = { ...(cx.uploads || {}), [role]: { ...info, filename: file.name } };
    if (role === "telemetry") {
      cx.inspect = { columns: info.columns, preview: info.preview, guess: info.guess, table: file.name };
      Object.assign(cx, { layout: info.guess.layout, time_col: info.guess.time_col, channel_col: info.guess.channel_col,
        value_col: info.guess.value_col, text_col: info.guess.text_col, table: null });
    } else {
      cx.cmdInspect = { columns: info.columns, preview: info.preview, guess: info.guess, table: file.name };
      cx.cmdTime = info.guess.time_col;
      cx.cmdCol = info.guess.command_col;
    }
  });
}

/* ── Rendering ── */

function renderConnect() {
  const cx = state.cx;
  const stepper = CX_STEPS.map((label, i) =>
    `<li class="${i < cx.step ? "done" : i === cx.step ? "now" : ""}"><span>${i < cx.step ? "✓" : i + 1}</span>${label}</li>`).join("");
  const body = [cxStepConnect, cxStepTelemetry, cxStepChannels, cxStepCommands, cxStepReview][cx.step](cx);
  return `
  <section class="src-card cx ${cx.busy ? "is-busy" : ""}">
    <div class="src-card-head">
      <div class="src-title">
        <span class="src-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M8 12 12 8M6.5 9.5 4.8 11.2a3 3 0 0 0 4.2 4.2l1.5-1.5M13.5 10.5l1.7-1.7a3 3 0 0 0-4.2-4.2L9.5 6.1"/></svg></span>
        <div><h2>Connect mission history</h2><p>ORBIT only reads. Nothing is written to your database.</p></div>
      </div>
      <button type="button" class="text-btn" data-cx="close">Cancel</button>
    </div>
    <ol class="cx-steps">${stepper}</ol>
    ${cx.error ? `<div class="cx-error">⚠ ${escapeHtml(cx.error)}</div>` : ""}
    ${body}
  </section>`;
}

function cxNav(back, next, nextLabel, disabled = false, hint = "") {
  return `<div class="cx-nav">
    ${back ? `<button type="button" class="btn btn-ghost" data-cx-back>Back</button>` : "<span></span>"}
    <span class="cx-hint">${hint}</span>
    ${next ? `<button type="button" class="btn" data-cx="${next}" ${disabled || state.cx.busy ? "disabled" : ""}>${state.cx.busy ? "Working…" : nextLabel}</button>` : ""}
  </div>`;
}

function cxStepConnect(cx) {
  const tabs = `<div class="cx-tabs" role="tablist">
    <button type="button" class="${cx.kind === "postgres" ? "on" : ""}" data-cx-kind="postgres"><b>Database</b><small>Postgres · TimescaleDB</small></button>
    <button type="button" class="${cx.kind === "csv" ? "on" : ""}" data-cx-kind="csv"><b>Upload CSV</b><small>Exports from your ground software</small></button>
  </div>`;
  if (cx.kind === "csv") {
    const up = cx.uploads || {};
    const slot = (role, label, hint) => `
      <label class="cx-drop ${up[role] ? "has" : ""}">
        <input type="file" accept=".csv,text/csv" data-cx-upload="${role}" />
        <b>${up[role] ? `✓ ${escapeHtml(up[role].filename)}` : label}</b>
        <small>${up[role] ? `${srcNum(up[role].rows)} rows · ${up[role].columns.length} columns` : hint}</small>
      </label>`;
    return `${tabs}
      <div class="cx-grid2">
        ${slot("telemetry", "Telemetry CSV", "A time column, then one column per channel, or time / channel / value rows")}
        ${slot("commands", "Command log CSV (optional)", "A time column and a command column")}
      </div>
      ${cxNav(false, "toTelemetry", "Next: telemetry", !up.telemetry)}`;
  }
  const t = cx.test;
  const demo = state.sourcesData.demo_db;
  const result = t?.ok ? `
    <div class="cx-ok">
      <div class="cx-ok-head"><span class="ic">✓</span><b>Connected</b><span class="muted">${escapeHtml(t.server)} · ${t.latency_ms} ms${t.timescale ? " · TimescaleDB" : ""}</span></div>
      <ul class="cx-checks">
        <li class="${t.read_only ? "ok" : "warn"}">${t.read_only ? "Read-only login: ORBIT can't change anything" : "This login can write. A read-only login is safer."}</li>
        <li class="ok">${t.tables.length} tables found${t.guess.telemetry ? ` · telemetry looks like <code>${escapeHtml(t.guess.telemetry)}</code>` : ""}${t.guess.commands ? `, commands like <code>${escapeHtml(t.guess.commands)}</code>` : ""}</li>
        ${t.synthetic ? `<li class="info">This database is marked as dummy data</li>` : ""}
      </ul>
    </div>` : "";
  return `${tabs}
    <label class="cx-field"><span>Database URL</span>
      <input id="cx-url" type="text" spellcheck="false" autocomplete="off" value="${escapeHtml(cx.url || "")}" placeholder="postgresql://user:password@host:5432/database" />
    </label>
    <p class="cx-help">Use a read-only login. The password stays on this machine.
      ${demo?.ready ? `<button type="button" class="text-btn" data-cx="demo">Use the demo team database</button>` : ""}</p>
    <div class="cx-row"><button type="button" class="btn btn-ghost" data-cx="test" ${cx.busy ? "disabled" : ""}>${cx.busy && !t ? "Testing…" : "Test connection"}</button></div>
    ${result}
    ${cxNav(false, "toTelemetry", "Next: telemetry", !t?.ok)}`;
}

function cxColSelect(id, value, columns, allowNone = false) {
  return `<select data-cx-col="${id}">${allowNone ? `<option value="">None</option>` : ""}${columns.map((c) =>
    `<option value="${escapeHtml(c.name)}" ${c.name === value ? "selected" : ""}>${escapeHtml(c.name)} · ${escapeHtml(c.type)}</option>`).join("")}</select>`;
}

function cxPreview(ins) {
  if (!ins?.preview?.length) return "";
  return `<div class="cx-preview"><table><thead><tr>${ins.columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join("")}</tr></thead>
    <tbody>${ins.preview.map((r) => `<tr>${r.map((v) => `<td>${v == null ? '<span class="muted">null</span>' : escapeHtml(String(v))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function cxStepTelemetry(cx) {
  const ins = cx.inspect;
  const tables = cx.kind === "postgres" ? `
    <label class="cx-field"><span>Telemetry table</span>
      <select data-cx-table>${cx.test.tables.map((t) => `<option value="${escapeHtml(t.name)}" ${t.name === cx.table ? "selected" : ""}>${escapeHtml(t.name)} · ~${srcNum(t.rows)} rows</option>`).join("")}</select>
    </label>` : `<p class="cx-help">From <b>${escapeHtml(cx.uploads.telemetry.filename)}</b></p>`;
  if (!ins) return tables + cxNav(true, null, "");
  const layout = `
    <div class="cx-layout">
      <label class="${cx.layout === "long" ? "on" : ""}"><input type="radio" name="cx-layout" value="long" ${cx.layout === "long" ? "checked" : ""} data-cx-layout />
        <b>One row per sample</b><small>time · channel · value, the usual time-series layout</small></label>
      <label class="${cx.layout === "wide" ? "on" : ""}"><input type="radio" name="cx-layout" value="wide" ${cx.layout === "wide" ? "checked" : ""} data-cx-layout />
        <b>One column per channel</b><small>time, then a column for each measurement</small></label>
    </div>`;
  const cols = ins.columns;
  const pickers = cx.layout === "long" ? `
    <div class="cx-grid4">
      <label class="cx-field"><span>Time</span>${cxColSelect("time_col", cx.time_col, cols)}</label>
      <label class="cx-field"><span>Channel name</span>${cxColSelect("channel_col", cx.channel_col, cols)}</label>
      <label class="cx-field"><span>Numeric value</span>${cxColSelect("value_col", cx.value_col, cols)}</label>
      <label class="cx-field"><span>Text value</span>${cxColSelect("text_col", cx.text_col, cols, true)}</label>
    </div>` : `<div class="cx-grid4"><label class="cx-field"><span>Time</span>${cxColSelect("time_col", cx.time_col, cols)}</label></div>`;
  const ok = cx.time_col && (cx.layout === "wide" || (cx.channel_col && cx.value_col));
  return `${tables}
    <p class="src-label">How is it laid out? <span class="muted">ORBIT guessed from the columns.</span></p>
    ${layout}${pickers}
    <p class="src-label">First rows</p>${cxPreview(ins)}
    ${cxNav(true, "toChannels", "Next: map channels", !ok)}`;
}

function cxStepChannels(cx) {
  const statsByName = Object.fromEntries((cx.stats || []).map((s) => [s.name, s]));
  const options = (sel) => `<option value="">Not mapped</option>${cx.stats.map((s) =>
    `<option value="${escapeHtml(s.name)}" ${s.name === sel ? "selected" : ""}>${escapeHtml(s.name)}</option>`).join("")}`;
  const missing = CX_REQUIRED.filter((o) => !cx.map.find((m) => m.orbit === o)?.source);
  const rows = cx.map.map((m, i) => {
    const st = statsByName[m.source];
    const r2 = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Number(v).toFixed(2));
    const range = st ? (st.median != null ? `${r2(st.min)} – ${r2(st.max)}` : `e.g. ${st.sample_text ?? "—"}`) : "—";
    const scaled = st && st.median != null ? `${(st.min * m.scale).toFixed(2)} – ${(st.max * m.scale).toFixed(2)} ${m.unit}` : "";
    const chip = !m.source ? (CX_REQUIRED.includes(m.orbit) ? `<span class="cx-chip bad">Needed</span>` : `<span class="cx-chip mute">Optional</span>`)
      : Number(m.scale) !== 1 ? `<span class="cx-chip warn">Unit fixed</span>`
      : m.confidence === "high" ? `<span class="cx-chip ok">Match</span>` : `<span class="cx-chip warn">Check</span>`;
    return `<tr class="${m.unit_note ? "has-note" : ""}">
      <td><b>${escapeHtml(CX_ORBIT_LABEL[m.orbit] || m.orbit)}</b><small>${escapeHtml(m.orbit)} · ${escapeHtml(m.unit || "")}</small></td>
      <td><select data-cx-map="${i}">${options(m.source)}</select></td>
      <td class="num">${escapeHtml(range)}</td>
      <td><select data-cx-scale="${i}" ${m.orbit === "PAY.mode" || !m.source ? "disabled" : ""}>
        ${[["1", "as is"], ["0.001", "÷ 1000 (milli → base)"], ["1000", "× 1000"]].map(([v, l]) => `<option value="${v}" ${Number(v) === Number(m.scale) ? "selected" : ""}>${l}</option>`).join("")}
      </select>${scaled && Number(m.scale) !== 1 ? `<small class="cx-after">→ ${escapeHtml(scaled)}</small>` : ""}</td>
      <td>${chip}</td>
    </tr>${m.unit_note ? `<tr class="cx-note"><td colspan="5">⚠ ${escapeHtml(m.unit_note)}</td></tr>` : ""}`;
  }).join("");
  const mapped = cx.map.filter((m) => m.source).length;
  return `
    <p class="cx-help">ORBIT matched your names to its channels and checked each one's numbers against the units it expects. Confirm or change anything below.</p>
    <table class="cx-map"><thead><tr><th>ORBIT channel</th><th>Your channel</th><th class="num">Values seen</th><th>Units</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    ${cx.unused?.length ? `<p class="cx-help muted">Not used by ORBIT: ${cx.unused.map((u) => `<code>${escapeHtml(u)}</code>`).join(" ")}</p>` : ""}
    ${cxNav(true, "toCommands", "Next: commands", missing.length > 0,
      missing.length ? `Map ${missing.map((o) => CX_ORBIT_LABEL[o]).join(", ")} to continue. The power model needs them.` : `${mapped} of ${cx.map.length} mapped`)}`;
}

function cxStepCommands(cx) {
  const tablePick = cx.kind === "postgres" ? `
    <div class="cx-grid4">
      <label class="cx-field"><span>Command log table</span>
        <select data-cx-cmdtable><option value="">No command log</option>${cx.test.tables.map((t) => `<option value="${escapeHtml(t.name)}" ${t.name === cx.cmdTable ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}</select></label>
      ${cx.cmdInspect ? `<label class="cx-field"><span>Time</span><select data-cx-cmdtime>${cx.cmdInspect.columns.map((c) => `<option ${c.name === cx.cmdTime ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label>
      <label class="cx-field"><span>Command name</span><select data-cx-cmdcol>${cx.cmdInspect.columns.map((c) => `<option ${c.name === cx.cmdCol ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></label>` : ""}
    </div>` : (cx.uploads?.commands ? `<p class="cx-help">From <b>${escapeHtml(cx.uploads.commands.filename)}</b></p>` : `<p class="cx-help">No command log uploaded. ORBIT can still learn from telemetry, but backtests need commands.</p>`);
  const orbitOpts = (sel) => `<option value="">Not mapped (ignored by the model)</option>${Object.entries(cx.orbitCmds || {}).map(([k, v]) =>
    `<option value="${k}" ${k === sel ? "selected" : ""}>${escapeHtml(v)}</option>`).join("")}`;
  const list = cx.cmds ? `
    <table class="cx-map"><thead><tr><th>Your command</th><th class="num">Times sent</th><th>What it does</th><th></th></tr></thead>
    <tbody>${cx.cmds.map((c, i) => `<tr><td><code>${escapeHtml(c.name)}</code></td><td class="num">${c.count}</td>
      <td><select data-cx-cmdmap="${i}">${orbitOpts(c.orbit)}</select></td>
      <td>${c.orbit ? `<span class="cx-chip ok">Mapped</span>` : `<span class="cx-chip mute">Ignored</span>`}</td></tr>`).join("")}</tbody></table>
    <p class="cx-help muted">Commands ORBIT doesn't understand still show on timelines. They just aren't used to learn or test the model.</p>` : "";
  return `<p class="cx-help">Commands are the model's experiments: each switch-on is a clean before-and-after it can learn from.</p>
    ${tablePick}${list}${cxNav(true, "toReview", "Next: review")}`;
}

function cxStepReview(cx) {
  const mapped = cx.map.filter((m) => m.source);
  const fixed = mapped.filter((m) => Number(m.scale) !== 1);
  const cmdMapped = (cx.cmds || []).filter((c) => c.orbit);
  const cmdIgnored = (cx.cmds || []).filter((c) => !c.orbit);
  return `
    <label class="cx-field"><span>Name this source</span><input id="cx-name" type="text" value="${escapeHtml(cx.name)}" /></label>
    <ul class="cx-summary">
      <li><span class="ic ok">✓</span><span><b>${cx.kind === "postgres" ? escapeHtml(cx.url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:•••@")) : escapeHtml(cx.uploads.telemetry.filename)}</b>${cx.table ? ` · table <code>${escapeHtml(cx.table)}</code>` : ""} · ${cx.layout === "long" ? "one row per sample" : "one column per channel"}</span></li>
      <li><span class="ic ok">✓</span><span><b>${mapped.length} channels mapped</b>${fixed.length ? `, with ${fixed.length} unit fix${fixed.length > 1 ? "es" : ""} (${fixed.map((m) => `${escapeHtml(m.source)} ÷ 1000`).join(", ")})` : ""}</span></li>
      <li><span class="ic ${cmdMapped.length ? "ok" : "warn"}">${cmdMapped.length ? "✓" : "!"}</span><span><b>${cmdMapped.length} command types mapped</b>${cmdIgnored.length ? `, ${cmdIgnored.length} ignored (${cmdIgnored.map((c) => `<code>${escapeHtml(c.name)}</code>`).join(" ")})` : ""}</span></li>
    </ul>
    <p class="cx-help">Saving makes this ORBIT's history source and reads it once to check the mapping. The power model keeps its current numbers until you re-learn it from the new source.</p>
    ${cxNav(true, "save", cx.busy ? "Reading history…" : "Save and use this source")}`;
}

function bindConnect() {
  const root = $("sources-desk");
  root.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-src-connect]")) return cxStart();
    if (ev.target.closest("[data-src-reset]")) return cxActions.reset();
    const cx = state.cx;
    if (!cx) return;
    const act = ev.target.closest("[data-cx]");
    if (act) {
      const name = act.dataset.cx;
      if (name === "close") return cxClose();
      if (cxActions[name]) return cxActions[name]();
    }
    if (ev.target.closest("[data-cx-back]")) { cx.step = Math.max(0, cx.step - 1); cx.error = null; return renderSources(); }
    const kind = ev.target.closest("[data-cx-kind]");
    if (kind) { cx.kind = kind.dataset.cxKind; cx.error = null; return renderSources(); }
  });
  root.addEventListener("change", (ev) => {
    const cx = state.cx;
    if (!cx) return;
    const t = ev.target;
    if (t.matches("[data-cx-upload]") && t.files[0]) return cxUpload(t.dataset.cxUpload, t.files[0]);
    if (t.matches("[data-cx-table]")) return cxActions.pickTable(t.value);
    if (t.matches("[data-cx-layout]")) { cx.layout = t.value; return renderSources(); }
    if (t.matches("[data-cx-col]")) { cx[t.dataset.cxCol] = t.value || null; return renderSources(); }
    if (t.matches("[data-cx-map]")) {
      const m = cx.map[Number(t.dataset.cxMap)];
      m.source = t.value || null;
      m.confidence = "high"; m.unit_note = null; m.scale = 1;
      return renderSources();
    }
    if (t.matches("[data-cx-scale]")) { cx.map[Number(t.dataset.cxScale)].scale = Number(t.value); m_noteClear(cx, Number(t.dataset.cxScale)); return renderSources(); }
    if (t.matches("[data-cx-cmdtable]")) return cxActions.pickCmdTable(t.value);
    if (t.matches("[data-cx-cmdtime]")) { cx.cmdTime = t.value; return; }
    if (t.matches("[data-cx-cmdcol]")) return cxActions.pickCmdCol(t.value);
    if (t.matches("[data-cx-cmdmap]")) { cx.cmds[Number(t.dataset.cxCmdmap)].orbit = t.value || null; return renderSources(); }
  });
  root.addEventListener("input", (ev) => {
    if (ev.target.id === "cx-url" && state.cx) { state.cx.url = ev.target.value; state.cx.test = null; }
    if (ev.target.id === "cx-name" && state.cx) state.cx.name = ev.target.value;
  });
}

function m_noteClear(cx, i) {
  const m = cx.map[i];
  if (Number(m.scale) === 1) m.unit_note = null;
}

/* ══ Alarms in the connected history ═════════════════════════════════
   Shown on the Sources page and at the top of the Open case dialog.
   Opening one seals the window straight from the connected source. */

async function loadHistoryAlarms(force = false) {
  if (state.historyAlarms && !force) return state.historyAlarms;
  try {
    const res = await fetch(apiUrl("/history/alarms"));
    if (!res.ok) throw new Error(`alarms ${res.status}`);
    state.historyAlarms = await res.json();
  } catch (err) {
    state.historyAlarms = { error: err.message, episodes: [] };
  }
  return state.historyAlarms;
}

function historyAlarmRows(data, { compact = false } = {}) {
  const eps = data?.episodes || [];
  if (!eps.length) return `<p class="muted small">No alarms in this history: nothing stayed past a warn limit for two samples in a row.</p>`;
  return `<ul class="ha-list ${compact ? "compact" : ""}">${eps.map((e) => {
    const p = e.primary;
    const when = new Date(p.iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });
    const others = e.alarms.filter((a) => a.channel !== p.channel);
    const lead = e.lead_up.filter((l) => l.mapped);
    const leadText = lead.length
      ? `${lead.map((l) => `<code>${escapeHtml(l.source_name)}</code>`).join(", ")} ${durText(p.t - lead[lead.length - 1].t)} before`
      : "No commands in the 10 minutes before";
    const busy = state.openingAlarm === e.key;
    const action = e.case
      ? `<button type="button" class="btn btn-ghost" data-open-case="${escapeHtml(e.case)}">${escapeHtml(e.case)} →</button>`
      : `<button type="button" class="btn" data-open-history="${escapeHtml(e.key)}" ${busy ? "disabled" : ""}>${busy ? "Sealing…" : "Open case"}</button>`;
    return `<li class="ha-row">
      <span class="ha-when">${escapeHtml(when)} <small>UTC</small></span>
      <span class="ha-main">
        <b>${escapeHtml(p.label)} ${p.direction === "below" ? "dropped to" : "reached"} ${p.value} ${escapeHtml(p.unit || "")}</b>
        <small>warn ${p.limit} ${escapeHtml(p.unit || "")}${others.length ? ` · also tripped ${others.map((a) => escapeHtml(a.label)).join(", ")}` : ""}</small>
        ${compact ? "" : `<small>Lead-up: ${leadText}</small>`}
      </span>
      <span class="ha-act">${action}</span>
    </li>`;
  }).join("")}</ul>`;
}

async function openHistoryCase(key) {
  if (state.openingAlarm) return;
  state.openingAlarm = key;
  refreshAlarmLists();
  try {
    const res = await fetch(apiUrl("/history/alarms/open"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `open ${res.status}`);
    state.incidents = [data, ...state.incidents.filter((item) => item.id !== data.id)];
    state.historyAlarms = null;
    if (!$("slip").hidden) closeSlip();
    renderIncidents();
    await openIncident(data.id);
  } catch (err) {
    window.alert(`Couldn't open a case on that alarm.\n\n${err.message}`);
  } finally {
    state.openingAlarm = null;
    refreshAlarmLists();
  }
}

function refreshAlarmLists() {
  const src = $("src-alarms");
  if (src) src.innerHTML = historyAlarmRows(state.historyAlarms);
  renderSlipHistory();
}

async function renderSlipHistory() {
  const root = $("slip-history");
  if (!root) return;
  const data = state.historyAlarms;
  if (!data) {
    root.innerHTML = `<p class="pick-label">From your connected history</p><p class="pick-hint">Looking for alarms…</p>`;
    await loadHistoryAlarms();
    return renderSlipHistory();
  }
  const open = (data.episodes || []).filter((e) => !e.case);
  root.hidden = !(data.episodes || []).length;
  root.innerHTML = `
    <p class="pick-label">From your connected history <span class="opt">${escapeHtml(data.source || "")}</span></p>
    <p class="pick-hint">${open.length ? `${open.length} alarm${open.length === 1 ? "" : "s"} without a case yet. ORBIT seals the window straight from the source.` : "Every alarm in the history already has a case."}</p>
    ${historyAlarmRows(data, { compact: true })}
    <p class="slip-or"><span>or seal from an archive tape</span></p>`;
}

function bindHistoryAlarms() {
  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-open-history]");
    if (btn) {
      ev.preventDefault();
      openHistoryCase(btn.dataset.openHistory);
      return;
    }
    const existing = ev.target.closest("#sources-desk [data-open-case], #slip [data-open-case]");
    if (existing) {
      ev.preventDefault();
      if (!$("slip").hidden) closeSlip();
      openIncident(existing.dataset.openCase);
    }
  });
}
