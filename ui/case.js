/* ORBIT — case page.
   Loaded before app.js; shares its globals (state, $, escapeHtml, apiUrl, series, …)
   at call time. Everything here reads two things:
     state.workspace  — sealed telemetry + events + channel limits
     state.brief      — the structured investigation from GET/POST …/brief
   The brief carries every number shown in a sentence; this file only draws. */

const SVG_NS = "http://www.w3.org/2000/svg";

const TAG_CLASS = {
  OBSERVED: "observed",
  DERIVED: "derived",
  DOCUMENTED: "documented",
  HYPOTHESIS: "hypothesis",
  SIMULATED: "simulated",
};

const LANE_DEFAULTS = [
  { id: "heater", channel: "THM.heater_b_current", label: "Heater B current", color: "--ch-heater" },
  { id: "payload", channel: "PAY.payload_current", label: "Payload current", color: "--ch-payload" },
];

const PART_COLOR = { other: "--ch-other", payload: "--ch-payload", heater: "--ch-heater" };

/* ── small helpers ───────────────────────────────────────────────── */

function cssVar(name) {
  return `var(${name})`;
}

function svgEl(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

function hhmm(t) {
  return clock(t).slice(0, 5);
}

function tagChip(tag) {
  const cls = TAG_CLASS[tag] || "observed";
  return `<span class="tag tag-${cls}">${escapeHtml(tag)}</span>`;
}

function tagsHtmlList(tags) {
  return (tags || []).map(tagChip).join("");
}

function caseBrief() {
  const b = state.brief;
  return b && !b.error && !b.no_crossing ? b : null;
}

function caseSim() {
  return caseBrief()?.simulation || null;
}

function caseStatus() {
  return state.incident?.status || "open";
}

function isClosed() {
  return caseStatus() === "filed";
}

function rowsBetween(id, t0, t1) {
  return series(id).filter((r) => r.time_s >= t0 && r.time_s <= t1 && r.value_num != null);
}

/* ── lifecycle ───────────────────────────────────────────────────── */

function lifecycleSteps() {
  const decision = state.incident?.decision;
  const hold = decision === "hold";
  const steps = hold
    ? ["Open", "Investigate", "Decide", "Watch", "Close"]
    : ["Open", "Investigate", "Decide", "Act", "Verify", "Close"];
  const st = caseStatus();
  let now;
  if (st === "filed") now = steps.length;
  else if (st === "watching") now = 3;
  else if (st === "verifying") now = 4;
  else if (st === "recommended" || caseBrief()) now = 2;
  else now = 1;
  return { steps, now };
}

function statusPill() {
  const st = caseStatus();
  const v = state.incident?.verify_result;
  if (st === "filed") return { text: v?.clears ? "Closed · confirmed" : "Closed", tone: "ok" };
  if (st === "verifying") return v?.clears === false ? { text: "Fix did not hold", tone: "crit" } : { text: "Verifying", tone: "ok" };
  if (st === "watching") return { text: "Watching", tone: "info" };
  if (caseBrief()) return { text: "Needs decision", tone: "warn" };
  return { text: "Not investigated", tone: "mute" };
}

/* ── header ──────────────────────────────────────────────────────── */

function renderCaseHead() {
  const inc = state.incident || {};
  const b = caseBrief();
  const a = analysis();
  $("case-crumb-id").textContent = inc.id || "";
  const pill = statusPill();
  const pillEl = $("case-status");
  pillEl.textContent = pill.text;
  pillEl.className = `case-status tone-${pill.tone}`;
  $("case-desk").dataset.tone = pill.tone;

  $("case-title").textContent = b?.headline || (inc.id ? caseHeadline(inc) : "Select a case");
  const lede = $("case-lede");
  if (state.investigating) {
    lede.textContent = "ORBIT is reading the sealed tape, walking the procedure, and replaying the window…";
  } else if (state.brief?.error) {
    lede.textContent = `The investigation brief could not be built: ${state.brief.error}`;
  } else if (b) {
    lede.textContent = b.lede;
  } else if (state.brief?.no_crossing) {
    lede.textContent = state.brief.headline;
  } else {
    lede.textContent = "ORBIT hasn't investigated this alarm yet. The telemetry below is the sealed window; run the investigation to get explanations and a recommendation.";
  }

  const run = $("case-run");
  run.hidden = isClosed();
  run.disabled = !!state.investigating;
  run.textContent = state.investigating ? "Investigating…" : b ? "Re-run investigation" : "Run investigation";
  run.classList.toggle("is-secondary", !!b);

  $("case-facts").innerHTML = factTiles(b, a);

  const { steps, now } = lifecycleSteps();
  $("case-stepper").innerHTML = steps
    .map((label, i) => {
      const cls = i < now ? "done" : i === now ? "now" : "";
      const line = i ? `<span class="step-line ${i <= now ? "done" : ""}"></span>` : "";
      return `${line}<span class="step ${cls}"><span class="dot">${i < now ? "✓" : i + 1}</span>${label}</span>`;
    })
    .join("");
}

function factTiles(b, a) {
  const tile = (k, v, s, tone = "") =>
    `<div class="fact"><div class="k">${k}</div><div class="v ${tone}">${v}</div><div class="s">${s}</div></div>`;
  const ch = alarmChannel();
  const m = meta(ch) || {};
  if (b) {
    const f = b.facts;
    const unit = f.alarm.unit || "";
    const ex = f.extreme || {};
    let exSub = "";
    if (ex.margin != null) {
      exSub = ex.margin >= 0
        ? `${fmt(ex.margin, 2)} ${unit} from critical (${ex.critical})`
        : `${fmt(-ex.margin, 2)} ${unit} past critical (${ex.critical})`;
    }
    const leadTone = { heater: "heater", payload: "payload", battery: "battery" }[f.leading.family] || "";
    return [
      tile("Alarm", `${fmt(f.alarm.value, 2)} ${unit}`, `${escapeHtml(readableChannel(f.alarm.channel))} · ${f.alarm.clock} UTC`, "warn"),
      tile(ex.kind === "highest" ? "Highest on tape" : "Lowest on tape", ex.value != null ? `${fmt(ex.value, 2)} ${unit}` : "—",
        escapeHtml(exSub), ex.margin != null && ex.margin < 0 ? "crit" : ""),
      tile("Leading cause", escapeHtml(f.leading.label), escapeHtml(f.leading.sub || ""), leadTone),
      tile("Procedure", escapeHtml(f.procedure.id), escapeHtml(f.procedure.sub), ""),
    ].join("");
  }
  const warn = a?.warn;
  const unit = m.unit || "";
  return [
    tile("Alarm", warn ? `${fmt(warn.value_num, 2)} ${unit}` : "—", warn ? `${escapeHtml(readableChannel(ch))} · ${clock(warn.time_s)} UTC` : "No warn crossing", "warn"),
    tile("Limit", m.warn_limit != null ? `${m.warn_limit} ${unit}` : "—", m.critical_limit != null ? `critical ${m.critical_limit} ${unit}` : "", ""),
    tile("Leading cause", "—", "Run the investigation", ""),
    tile("Procedure", "—", "Chosen by the investigation", ""),
  ].join("");
}

/* ── 01 What happened ───────────────────────────────────────────── */

function laneSpec() {
  const b = caseBrief();
  if (b) return b.lanes;
  const ch = alarmChannel();
  const voltage = ch === "EPS.battery_voltage"
    ? { id: "voltage", channel: ch, label: "Battery voltage", color: "--ch-batt" }
    : { id: "voltage", channel: ch === "THM.heater_b_current" || ch === "PAY.payload_current" ? "EPS.bus_voltage" : ch, label: "Bus voltage", color: "--ch-bus" };
  return [...LANE_DEFAULTS, voltage];
}

function laneMarkers() {
  const b = caseBrief();
  const out = {};
  if (b) {
    if (b.onsets.heater) out.heater = { t: b.onsets.heater.t, note: `${b.onsets.heater.clock} · switched on` };
    if (b.onsets.payload) out.payload = { t: b.onsets.payload.t, note: `${b.onsets.payload.clock} · science mode` };
    const lane = b.alarm_lane;
    const al = b.facts.alarm;
    out[lane] = { t: al.t, note: `${al.clock} · warn ${al.warn} ${al.unit || ""}`, warn: true };
    return out;
  }
  const a = analysis();
  if (a?.heaterCmd) out.heater = { t: a.heaterCmd.time_s, note: `${clock(a.heaterCmd.time_s)} · HEATER_B_ENABLE` };
  if (a?.science) out.payload = { t: a.science.time_s, note: `${clock(a.science.time_s)} · SCIENCE_MODE` };
  if (a?.warn) {
    const ch = alarmChannel();
    const lane = ch === "THM.heater_b_current" ? "heater" : ch === "PAY.payload_current" ? "payload" : "voltage";
    out[lane] = { t: a.warn.time_s, note: `${clock(a.warn.time_s)} · warn`, warn: true };
  }
  return out;
}

function laneRange() {
  const a = analysis();
  const b = caseBrief();
  const tWarn = b?.facts.alarm.t ?? a?.warn?.time_s;
  const events = b?.events?.map((e) => e.t) ?? (a?.windowEvents || []).map((e) => e.time_s);
  const all = series(alarmChannel());
  if (!all.length) return null;
  const lo = all[0].time_s;
  const hi = all[all.length - 1].time_s;
  if (tWarn == null) return [lo, hi];
  const first = Math.min(tWarn, ...events);
  return [Math.max(lo, first - 150), Math.min(hi, tWarn + 240)];
}

function drawLanes() {
  const svg = $("chart-lanes");
  if (!svg) return;
  svg.innerHTML = "";
  const range = laneRange();
  if (!range) return;
  const [a, b] = range;
  const W = 1000, L = 150, R = 22, lh = 64, top = 22;
  const lanes = laneSpec();
  const markers = laneMarkers();
  const x = (t) => L + ((t - a) / (b - a || 1)) * (W - L - R);
  svg.setAttribute("viewBox", `0 0 ${W} ${top + lh * lanes.length + 26}`);

  const step = b - a > 900 ? 120 : 60;
  for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
    svgEl("line", { x1: x(t), x2: x(t), y1: top - 6, y2: top + lh * lanes.length, class: "grid" }, svg);
    if ((t / step) % 2 === 0) svgEl("text", { x: x(t), y: top + lh * lanes.length + 16, "text-anchor": "middle", text: hhmm(t) }, svg);
  }

  lanes.forEach((ln, i) => {
    const y0 = top + i * lh;
    const active = state.casePin?.lane === ln.id;
    svgEl("rect", { x: 0, y: y0, width: W, height: lh - 6, rx: 6, class: active ? "lane-bg is-on" : "lane-bg" }, svg);
    svgEl("text", { x: 10, y: y0 + lh / 2, class: "lane-label", style: `fill:${cssVar(ln.color)}`, text: ln.label }, svg);
    const rows = rowsBetween(ln.channel, a, b);
    if (!rows.length) return;
    const vals = rows.map((r) => r.value_num);
    const isCurrent = (meta(ln.channel)?.unit || "") === "A";
    let lo = isCurrent ? 0 : Math.min(...vals);
    let hi = Math.max(...vals);
    if (isCurrent) hi = Math.max(hi, 1.2);
    if (hi - lo < 0.5) { lo -= 0.25; hi += 0.25; }
    const pad = (hi - lo) * 0.08;
    const yy = (v) => y0 + (lh - 12) - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (lh - 24);
    const d = rows.map((r, k) => `${k ? "L" : "M"}${x(r.time_s).toFixed(1)},${yy(r.value_num).toFixed(1)}`).join("");
    svgEl("path", { d, class: "series", style: `stroke:${cssVar(ln.color)}` }, svg);
    const hiRow = rows.reduce((p, r) => (r.value_num > p.value_num ? r : p), rows[0]);
    const loRow = rows.reduce((p, r) => (r.value_num < p.value_num ? r : p), rows[0]);
    const unit = meta(ln.channel)?.unit || "";
    svgEl("text", { x: W - R, y: y0 + 12, "text-anchor": "end", class: "lane-range", text: `${fmt(loRow.value_num, 2)}–${fmt(hiRow.value_num, 2)} ${unit}` }, svg);
    const mk = markers[ln.id];
    if (mk && mk.t >= a && mk.t <= b) {
      svgEl("line", { x1: x(mk.t), x2: x(mk.t), y1: y0 + 2, y2: y0 + lh - 8, class: "onset", style: `stroke:${mk.warn ? cssVar("--warn") : cssVar(ln.color)}` }, svg);
      svgEl("circle", { cx: x(mk.t), cy: y0 + 6, r: 4, style: `fill:${mk.warn ? cssVar("--warn") : cssVar(ln.color)}` }, svg);
      const right = x(mk.t) < W - 260;
      svgEl("text", { x: x(mk.t) + (right ? 8 : -8), y: y0 + 10, "text-anchor": right ? "start" : "end", class: "onset-note", style: `fill:${mk.warn ? cssVar("--warn") : cssVar(ln.color)}`, text: mk.note }, svg);
    }
  });

  const bOn = caseBrief()?.onsets;
  if (bOn?.heater && bOn?.payload && bOn.heater.t < bOn.payload.t) {
    const by = top + lh * lanes.length - 2;
    const x1 = x(bOn.heater.t), x2 = x(bOn.payload.t);
    svgEl("path", { d: `M${x1},${by - 4}V${by}H${x2}V${by - 4}`, class: "lead-bracket" }, svg);
    svgEl("text", { x: (x1 + x2) / 2, y: by - 6, "text-anchor": "middle", class: "lead-note", text: `heater leads by ${durText(bOn.payload.t - bOn.heater.t)}` }, svg);
  }
  drawPinLine(svg, x, top - 8, top + lh * lanes.length, a, b);
}

function durText(s) {
  s = Math.round(Math.abs(s));
  const m = Math.floor(s / 60), r = s % 60;
  if (m && r) return `${m} min ${r} s`;
  if (m) return `${m} min`;
  return `${r} s`;
}

function drawPinLine(svg, x, y1, y2, a, b) {
  const t = state.casePin?.t;
  if (t == null || t < a || t > b) return;
  const px = x(t);
  svgEl("line", { x1: px, x2: px, y1, y2, class: "pin-line" }, svg);
  svgEl("rect", { x: px - 31, y: y1 - 14, width: 62, height: 15, rx: 3, class: "pin-tag" }, svg);
  svgEl("text", { x: px, y: y1 - 3, "text-anchor": "middle", class: "pin-text", text: clock(t) }, svg);
}

function drawBreakdown() {
  const svg = $("chart-breakdown");
  const b = caseBrief();
  if (!svg || !b) return;
  svg.innerHTML = "";
  const L = b.loads;
  const H = 250, P = { l: 46, b: 26, t: 16 };
  const warn = meta("EPS.bus_current")?.warn_limit ?? 6;
  const after = (L.other.after || 0) + (L.payload.after || 0) + (L.heater.after || 0);
  const max = Math.max(after, L.bus.before || 0, warn) * 1.12;
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const tick = max > 6 ? 2 : 1;
  for (let v = 0; v <= max; v += tick) {
    svgEl("line", { x1: P.l, x2: 470, y1: y(v), y2: y(v), class: "grid" }, svg);
    svgEl("text", { x: P.l - 8, y: y(v) + 3.5, "text-anchor": "end", text: `${v} A` }, svg);
  }
  svgEl("line", { x1: P.l, x2: 470, y1: y(warn), y2: y(warn), class: "limit", style: `stroke:${cssVar("--warn")}` }, svg);
  svgEl("text", { x: P.l + 4, y: y(warn) - 5, style: `fill:${cssVar("--warn")}`, text: `bus-current warn ${warn} A` }, svg);
  const bars = [
    { x: 100, label: `before · ${L.before_label}`, when: "before" },
    { x: 260, label: `after · ${L.after_label}`, when: "after" },
  ];
  const pinPart = state.casePin?.part;
  bars.forEach((bar) => {
    let acc = 0;
    for (const part of ["other", "payload", "heater"]) {
      const v = Math.max(0, L[part][bar.when] || 0);
      const dim = pinPart && bar.when === "after" && pinPart !== part;
      svgEl("rect", {
        x: bar.x, width: 90, y: y(acc + v), height: Math.max(0.5, y(acc) - y(acc + v)), rx: 2,
        style: `fill:${cssVar(PART_COLOR[part])};opacity:${dim ? 0.3 : 0.9}`,
        class: pinPart === part && bar.when === "after" ? "bar is-on" : "bar",
      }, svg);
      acc += v;
    }
    svgEl("text", { x: bar.x + 45, y: H - 8, "text-anchor": "middle", text: bar.label }, svg);
    svgEl("text", { x: bar.x + 45, y: y(acc) - 6, "text-anchor": "middle", class: "bar-total", text: `${fmt(acc, 2)} A` }, svg);
  });
  const lx = 372;
  let acc = 0;
  const labels = [];
  for (const part of ["other", "payload", "heater"]) {
    const v = Math.max(0, L[part].after || 0);
    labels.push({ part, mid: acc + v / 2, d: L[part].delta });
    acc += v;
  }
  // Top-down (heater first): keep each label at its segment, nudged down to stay 15px apart.
  let lastY = -Infinity;
  labels.reverse().forEach(({ part, mid, d }) => {
    if (d == null) return;
    const ly = Math.max(y(mid), lastY + 15);
    lastY = ly;
    const name = { heater: "Heater B", payload: "payload", other: "other" }[part];
    svgEl("line", { x1: 352, x2: lx - 4, y1: y(mid), y2: ly, style: `stroke:${cssVar(PART_COLOR[part])}` }, svg);
    svgEl("text", { x: lx, y: ly + 3.5, class: part === "other" ? "muted" : "", style: part === "other" ? "" : `fill:${cssVar(PART_COLOR[part])}`, text: `${d >= 0 ? "+" : ""}${fmt(d, 2)} A ${name}` }, svg);
  });
}

function renderHappened() {
  const b = caseBrief();
  const charts = b?.charts?.items || [];
  const lanesC = charts.find((c) => c.kind === "lanes");
  const breakC = charts.find((c) => c.kind === "breakdown");
  $("happened-title").textContent = b
    ? (b.onsets.heater && b.onsets.payload ? (b.onsets.heater.t < b.onsets.payload.t ? "The heater moved first. The payload came later." : "The payload moved first.") : "What the sealed telemetry shows")
    : "What the sealed telemetry shows";
  $("chosen").hidden = !b;
  $("chosen-why").innerHTML = charts.map((c) => `<li><b>${escapeHtml(c.title)}</b>: ${escapeHtml(c.why)}</li>`).join("");
  $("chosen-source").textContent = b?.sealed?.id || state.runId || "";
  $("lanes-legend").innerHTML = laneSpec()
    .map((ln) => `<span><i style="background:${cssVar(ln.color)}"></i>${escapeHtml(ln.label.replace(" current", "").replace(" voltage", " V"))}</span>`)
    .join("");
  $("lanes-cap").innerHTML = lanesC
    ? `${lanesC.caption} ${tagsHtmlList(lanesC.tags)}`
    : "Commands and the alarm are marked on each signal. Run the investigation to see which moved first.";
  drawLanes();
  const breakdown = $("viz-breakdown");
  breakdown.hidden = !b;
  if (b) {
    $("breakdown-cap").innerHTML = `${breakC?.caption || ""} ${tagsHtmlList(breakC?.tags)}`;
    drawBreakdown();
  }
  renderLeadUp();
}

function renderLeadUp() {
  const b = caseBrief();
  const a = analysis();
  const events = b
    ? b.events.map((e) => ({ t: e.t, detail: e.detail, channel: e.channel }))
    : (a?.windowEvents || []).map((e) => ({ t: e.time_s, detail: e.detail, channel: e.channel }));
  const warn = b ? { t: b.facts.alarm.t, label: `${readableChannel(b.facts.alarm.channel)} crossed warn` } : a?.warn ? { t: a.warn.time_s, label: "First warn" } : null;
  const items = events.map((e) => ({ t: e.t, text: e.detail, sub: e.channel, kind: "cmd" }));
  if (warn) items.push({ t: warn.t, text: warn.label, sub: "alarm", kind: "warn" });
  items.sort((p, q) => p.t - q.t);
  const pinT = state.casePin?.t;
  $("leadup").innerHTML = items.length
    ? items
        .map(
          (it) => `<li><button type="button" class="leadup-item kind-${it.kind}${pinT === it.t ? " is-on" : ""}" data-case-pin="${it.t}">
            <span class="mono">${clock(it.t)}</span><span><b>${escapeHtml(it.text)}</b><small>${escapeHtml(it.sub)}</small></span></button></li>`
        )
        .join("")
    : `<li class="muted">No commands in the 10 minutes before the warn.</li>`;
  $("viz-leadup").classList.toggle("is-wide", !b);
}

/* ── 02 Competing explanations ──────────────────────────────────── */

const VERDICT_LABEL = { leading: "LEADING", below_bar: "BELOW BAR", ruled_out: "RULED OUT", insufficient: "OPEN" };

function renderExplain() {
  const b = caseBrief();
  const root = $("hyps");
  $("sec-explain").classList.toggle("is-locked", !b);
  if (!b) {
    $("explain-title").textContent = "Explanations appear after the investigation";
    $("explain-lede").textContent = "ORBIT weighs each candidate cause against the procedure bars and shows the evidence for and against it.";
    root.innerHTML = "";
    return;
  }
  const open = b.hypotheses.filter((h) => h.verdict === "leading" || h.verdict === "below_bar");
  const n = b.hypotheses.length;
  $("explain-title").textContent = b.family === "withheld"
    ? `${n} causes fit the alarm. None clears the procedure bar.`
    : `${n} causes fit the alarm. Only one fits the evidence.`;
  $("explain-lede").textContent = "Click a line of evidence to see where it shows up in the charts.";
  state.caseExpanded = state.caseExpanded || new Set(open.map((h) => h.id));
  root.innerHTML = b.hypotheses.map((h) => hypCard(h, state.caseExpanded.has(h.id))).join("");
  root.querySelectorAll("[data-proof-slot]").forEach((slot) => drawProof(slot.dataset.proofSlot, slot.querySelector("svg")));
}

function hypCard(h, expanded) {
  const cls = h.verdict === "leading" ? "lead" : h.verdict === "below_bar" ? "below" : "out";
  const ev = h.evidence
    .map((e, i) => {
      const pinnable = !!(e.pin && (e.pin.t != null || e.pin.part));
      const proofKey = `${h.id}:${i}`;
      const proofOpen = state.caseProofs?.has(proofKey);
      const proofBtn = e.proof && caseSim()
        ? `<button type="button" class="proof-btn" data-proof="${escapeHtml(proofKey)}" data-proof-kind="${e.proof}" aria-expanded="${proofOpen}">
             ${proofOpen ? "▾ Hide" : "▸ Show"} ${e.proof === "whatif" ? "replay" : "healthy switch-on"}<span class="sim-mark">✦ simulated</span></button>`
        : "";
      const slot = proofOpen ? `<div class="proof-slot" data-proof-slot="${e.proof}">${proofChartShell(e.proof)}</div>` : "";
      const active = state.casePinKey === `${h.id}:${i}` ? " is-on" : "";
      return `<li class="ev-line${active}" ${pinnable ? `data-ev-pin data-ev-key="${h.id}:${i}" tabindex="0"` : ""}>
          <span class="sgn ${e.sign === "+" ? "p" : "m"}">${e.sign === "+" ? "+" : "−"}</span>
          <span class="ev-body">${escapeHtml(e.text)}<span class="ev-meta">${tagsHtmlList(e.tags)}${proofBtn}</span>${slot}</span>
        </li>`;
    })
    .join("");
  const pros = h.evidence.filter((e) => e.sign === "+").length;
  const cons = h.evidence.length - pros;
  return `<article class="hyp ${cls}${expanded ? " is-open" : ""}" style="--hc:${cssVar(h.color)}">
      <button type="button" class="hyp-top" data-hyp-toggle="${h.id}" aria-expanded="${expanded}">
        <span class="hyp-name"><span class="code">${escapeHtml(h.fault)} · ${escapeHtml(h.procedure)}</span><b>${escapeHtml(h.name)}</b></span>
        <span class="hyp-score"><span class="p">+${pros}</span><span class="m">−${cons}</span></span>
        <span class="verdict v-${cls}">${VERDICT_LABEL[h.verdict] || h.verdict}</span>
        <span class="chev" aria-hidden="true">▾</span>
      </button>
      <p class="hyp-reason">${escapeHtml(h.reason)}</p>
      <div class="hyp-body">
        <ul class="ev">${ev}</ul>
        ${h.footer ? `<p class="hyp-foot">${escapeHtml(h.footer)}</p>` : ""}
      </div>
    </article>`;
}

function proofChartShell(kind) {
  const sim = caseSim();
  const cap = kind === "whatif" ? sim?.whatif?.caption : sim?.healthy?.caption;
  const legend = kind === "whatif"
    ? `<span><i style="background:var(--ch-bus)"></i>what happened</span><span class="dash-l"><i></i>model rebuild with ${escapeHtml(sim?.whatif?.removed || "")} healthy</span>`
    : `<span><i style="background:var(--ch-heater)"></i>today</span><span class="dash-l"><i></i>healthy draw learned from history</span>`;
  return `<div class="proof-legend">${legend}</div><svg class="chart" viewBox="0 0 1000 230"></svg>
    <p class="viz-cap">${cap || ""} ${tagChip("DERIVED")} ${tagChip("SIMULATED")}</p>`;
}

function drawProof(kind, svg) {
  const sim = caseSim();
  if (!sim || !svg) return;
  if (kind === "whatif" && sim.whatif) {
    const wi = sim.whatif;
    const vals = [...wi.actual, ...wi.healthy].map((p) => p[1]);
    const ev = (caseBrief()?.events || []).map((e) => ({ t: e.t, label: e.detail.replace("HEATER_B_ENABLE", "heater on").replace("SCIENCE_MODE", "science mode") }));
    lineChart(svg, {
      x: wi.window,
      y: niceDomain(vals, [wi.warn, wi.critical]),
      unit: ` ${wi.unit}`,
      limits: limitLines({ warn: wi.warn, critical: wi.critical, unit: wi.unit }),
      events: ev,
      series: [
        { pts: wi.actual, color: "--ch-bus", w: 2 },
        { pts: wi.healthy, color: "--signal", w: 2.2, dash: true },
      ],
    });
  } else if (kind === "healthy" && sim.healthy) {
    const h = sim.healthy;
    const vals = [...h.actual, ...h.healthy].map((p) => p[1]);
    const color = h.channel === "PAY.payload_current" ? "--ch-payload" : "--ch-heater";
    lineChart(svg, {
      x: h.window,
      y: [0, Math.max(...vals, h.bar) * 1.15],
      unit: " A",
      bands: [{ lo: h.nominal[0], hi: h.nominal[1], color: "--signal", label: `healthy ${h.nominal[0]}–${h.nominal[1]} A` }],
      limits: [{ v: h.bar, color: "--hypothesis", label: "2× bar" }],
      events: [{ t: h.onset.t, label: h.onset.label }],
      series: [
        { pts: h.healthy, color: "--text-3", dash: true, w: 1.8 },
        { pts: h.actual, color, w: 2.4 },
      ],
    });
  }
}

function limitLines(sim) {
  const out = [{ v: sim.warn, color: "--warn", label: `warn ${sim.warn} ${sim.unit}` }];
  if (sim.critical != null) out.push({ v: sim.critical, color: "--crit", label: `critical ${sim.critical} ${sim.unit}` });
  return out;
}

function niceDomain(vals, extra = []) {
  const all = [...vals, ...extra.filter((v) => v != null)];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 0.5;
  lo -= pad; hi += pad;
  return [Math.floor(lo * 2) / 2, Math.ceil(hi * 2) / 2];
}

/** Generic line chart: limits, bands, event markers, solid/dashed series, pin. */
function lineChart(svg, o) {
  svg.innerHTML = "";
  const [, , W, H] = svg.getAttribute("viewBox").split(" ").map(Number);
  const P = { l: 52, r: 14, t: 24, b: 24 };
  const x = (t) => P.l + ((t - o.x[0]) / (o.x[1] - o.x[0] || 1)) * (W - P.l - P.r);
  const y = (v) => H - P.b - ((v - o.y[0]) / (o.y[1] - o.y[0] || 1)) * (H - P.t - P.b);
  const span = o.y[1] - o.y[0];
  const step = span > 6 ? 2 : span > 2.5 ? 1 : span > 1.2 ? 0.5 : 0.25;
  for (let v = Math.ceil(o.y[0] / step) * step; v <= o.y[1] + 1e-9; v += step) {
    svgEl("line", { x1: P.l, x2: W - P.r, y1: y(v), y2: y(v), class: "grid" }, svg);
    svgEl("text", { x: P.l - 8, y: y(v) + 3.5, "text-anchor": "end", text: `${+v.toFixed(2)}${o.unit || ""}` }, svg);
  }
  const xStep = o.x[1] - o.x[0] > 1500 ? 300 : 120;
  for (let t = Math.ceil(o.x[0] / xStep) * xStep; t <= o.x[1]; t += xStep) {
    svgEl("text", { x: x(t), y: H - 6, "text-anchor": "middle", text: hhmm(t) }, svg);
  }
  (o.bands || []).forEach((band) => {
    svgEl("rect", { x: P.l, width: W - P.l - P.r, y: y(band.hi), height: Math.max(1, y(band.lo) - y(band.hi)), style: `fill:${cssVar(band.color)};opacity:.1` }, svg);
    svgEl("text", { x: W - P.r - 4, y: y(band.hi) - 4, "text-anchor": "end", style: `fill:${cssVar(band.color)}`, text: band.label }, svg);
  });
  (o.areas || []).forEach((a) => {
    const top = a.pts.map(([t, , hi]) => `${x(t).toFixed(1)},${y(Math.min(hi, o.y[1])).toFixed(1)}`);
    const bot = a.pts.slice().reverse().map(([t, lo]) => `${x(t).toFixed(1)},${y(Math.max(lo, o.y[0])).toFixed(1)}`);
    svgEl("polygon", { points: [...top, ...bot].join(" "), style: `fill:${cssVar(a.color)};opacity:.14` }, svg);
  });
  (o.limits || []).forEach((l) => {
    if (l.v < o.y[0] || l.v > o.y[1]) return;
    svgEl("line", { x1: P.l, x2: W - P.r, y1: y(l.v), y2: y(l.v), class: "limit", style: `stroke:${cssVar(l.color)}` }, svg);
    svgEl("text", { x: W - P.r - 4, y: y(l.v) - 5, "text-anchor": "end", style: `fill:${cssVar(l.color)}`, text: l.label }, svg);
  });
  if (o.shade) {
    svgEl("rect", { x: x(o.shade[0]), width: Math.max(0, x(o.shade[1]) - x(o.shade[0])), y: P.t, height: H - P.t - P.b, class: "shade" }, svg);
  }
  (o.events || []).forEach((e, i) => {
    if (e.t < o.x[0] || e.t > o.x[1]) return;
    svgEl("line", { x1: x(e.t), x2: x(e.t), y1: P.t - 6, y2: H - P.b, class: "event", style: e.color ? `stroke:${cssVar(e.color)}` : "" }, svg);
    svgEl("text", { x: x(e.t) + 4, y: P.t - 10 + (i % 2) * -0, "text-anchor": "start", style: e.color ? `fill:${cssVar(e.color)}` : "", text: e.label }, svg);
  });
  o.series.forEach((s) => {
    if (!s.pts?.length) return;
    const d = s.pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svgEl("path", { d, class: `series${s.dash ? " dash" : ""}`, style: `stroke:${cssVar(s.color)};stroke-width:${s.w || 2};opacity:${s.op ?? 1}` }, svg);
  });
  return { x, y };
}

/* ── 03 Decide ──────────────────────────────────────────────────── */

const RESULT_BADGE = {
  clears: { cls: "good", text: "✓ Clears warn" },
  fails: { cls: "bad", text: "✗ Doesn't clear" },
  stays: { cls: "meh", text: "△ Stays in warn" },
  borderline: { cls: "meh", text: "◇ Too close to call" },
};

const CONF_COPY = {
  high: { icon: "✓", title: "High confidence" },
  medium: { icon: "◐", title: "Medium confidence" },
  low: { icon: "⚠", title: "Low confidence" },
};

function renderConfidence() {
  const el = $("conf");
  const sim = caseSim();
  if (!el) return;
  if (!sim || !caseBrief()) { el.hidden = true; return; }
  el.hidden = false;
  if (!sim.decision) {
    el.className = "conf none";
    el.innerHTML = `<div class="conf-row"><span class="conf-ic">○</span><span class="conf-text"><b>No preview</b><span>${escapeHtml(sim.no_preview || "")}</span></span></div>`;
    return;
  }
  const f = sim.fit;
  const c = CONF_COPY[f.level] || CONF_COPY.medium;
  const open = !!state.confOpen;
  el.className = `conf lvl-${f.level}${open ? " is-open" : ""}`;
  el.innerHTML = `
    <button type="button" class="conf-row" id="conf-toggle" aria-expanded="${open}">
      <span class="conf-ic">${c.icon}</span>
      <span class="conf-text"><b>Preview confidence · ${c.title.split(" ")[0]}</b><span>${escapeHtml(f.text)}</span></span>
      <span class="conf-model">${sim.model.status === "calibrated" ? "Model learned from history" : "Datasheet values · not learned yet"}<span class="chev">▾</span></span>
    </button>
    ${open ? `<div class="conf-body">
      <div class="proof-legend"><span><i style="background:var(--ch-bus)"></i>what happened</span><span class="dash-l"><i></i>model replay from the measured currents</span></div>
      <svg class="chart" id="chart-fit" viewBox="0 0 1000 200"></svg>
      <p class="viz-cap">Before trusting its forecast, ORBIT rebuilds this case's last minutes from the currents it measured. The closer the two lines, the more the previews below can be trusted. ${sim.model.status === "calibrated" ? "" : "<b>Learn the model from history on the Sources page to tighten this.</b>"} <a href="/app/sources" data-go-sources>How the model was learned →</a></p>
    </div>` : ""}`;
  if (open) {
    const vals = [...f.observed, ...f.model].map((p) => p[1]);
    lineChart($("chart-fit"), {
      x: f.window,
      y: niceDomain(vals, []),
      unit: " V",
      series: [
        { pts: f.observed, color: "--ch-bus", w: 2 },
        { pts: f.model, color: "--signal", w: 2, dash: true },
      ],
    });
  }
}

function renderDecide() {
  const b = caseBrief();
  const sec = $("sec-decide");
  sec.classList.toggle("is-locked", !b);
  const sim = caseSim();
  const decided = state.incident?.decision;
  if (!b) {
    $("decide-title").textContent = "The decision comes after the evidence";
    $("decide-lede").textContent = "Once ORBIT has investigated, each option is replayed in the simulator so you can compare what happens next.";
    $("options").innerHTML = "";
    $("viz-preview").hidden = true;
    $("decide-form").hidden = true;
    return;
  }
  const opts = sim?.decision?.options || [{ id: b.recommendation.option, label: b.recommendation.label, recommended: true, text: b.recommendation.detail }];
  if (!state.caseOption || !opts.some((o) => o.id === state.caseOption)) {
    state.caseOption = decided || opts.find((o) => o.recommended)?.id || opts[0].id;
  }
  $("decide-title").textContent = isClosed()
    ? "Decision recorded"
    : decided
      ? "Decision recorded. You can change it until the case closes."
      : "Compare what happens next under each option.";
  $("decide-lede").innerHTML = sim?.decision
    ? `Each option is forecast from <b>${sim.decision.clock}</b> by ORBIT's power model. The shaded band is its uncertainty. ORBIT recommends; you decide. Nothing is sent to the spacecraft.`
    : "Options can't be previewed for this alarm. Nothing is sent to the spacecraft.";
  $("options").innerHTML = opts
    .map((o) => {
      const badge = RESULT_BADGE[o.result];
      const chosen = decided === o.id;
      return `<button type="button" class="opt${o.id === state.caseOption ? " sel" : ""}${chosen ? " chosen" : ""}" data-option="${o.id}" ${isClosed() ? "disabled" : ""}>
          <span class="t">${escapeHtml(o.label)} ${o.recommended ? '<span class="rec">RECOMMENDED</span>' : ""}${chosen ? '<span class="rec chosen-tag">APPROVED</span>' : ""}</span>
          <span class="o">${escapeHtml(o.text || "")}</span>
          ${badge ? `<span class="res ${badge.cls}">${badge.text}</span>` : ""}
          ${o.note ? `<span class="note">${escapeHtml(o.note)}</span>` : ""}
        </button>`;
    })
    .join("");
  renderConfidence();
  $("viz-preview").hidden = !sim?.decision;
  if (sim?.decision) drawPreview();
  const form = $("decide-form");
  form.hidden = isClosed();
  const btn = $("approve");
  const cur = opts.find((o) => o.id === state.caseOption);
  btn.disabled = !!state.deciding || (decided === state.caseOption);
  btn.textContent = state.deciding ? "Simulating…" : decided === state.caseOption ? "Approved" : `Approve · ${cur?.label || ""}`;
}

function drawPreview() {
  const sim = caseSim();
  const d = sim.decision;
  const color = { heater_off: "--signal", payload_safe: "--ch-payload", hold: "--text-3" };
  const sel = state.caseOption;
  const selBand = (d.options.find((o) => o.id === sel)?.band || []).flatMap(([, lo, hi]) => [lo, hi]);
  const vals = [...d.before.map((p) => p[1]), ...d.options.flatMap((o) => o.series.map((p) => p[1])), ...selBand];
  lineChart($("chart-preview"), {
    x: d.window,
    y: niceDomain(vals, [sim.warn, sim.critical]),
    unit: ` ${sim.unit}`,
    limits: limitLines(sim),
    events: [{ t: d.t, label: `decision ${d.clock.slice(0, 5)}`, color: "--text-2" }],
    shade: [d.window[0], d.t],
    bands: [],
    areas: d.options.filter((o) => o.id === sel && o.band).map((o) => ({ pts: o.band, color: color[o.id] })),
    series: [
      { pts: d.before, color: "--ch-bus", w: 2 },
      ...d.options
        .filter((o) => o.id !== sel)
        .map((o) => ({ pts: o.series, color: color[o.id], dash: true, w: 1.4, op: 0.5 })),
      ...d.options.filter((o) => o.id === sel).map((o) => ({ pts: o.series, color: color[o.id], w: 2.6 })),
    ],
  });
  $("preview-legend").innerHTML = d.options
    .map((o) => `<span class="${o.id === sel ? "" : "dim"}"><i style="background:${cssVar(color[o.id])}"></i>${escapeHtml(o.label)}</span>`)
    .join("");
}

async function approveDecision() {
  if (!state.incidentId || state.deciding) return;
  state.deciding = true;
  renderDecide();
  try {
    const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(state.incidentId)}/decide`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option: state.caseOption, note: $("decide-note").value || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `decide ${res.status}`);
    }
    const data = await res.json();
    state.incident = { ...state.incident, ...data.incident };
    applyIncidentPatch(state.incidentId, { status: data.status, decision: data.incident.decision });
    announceLive(`Decision recorded: ${data.verify_result?.label || state.caseOption}.`);
  } catch (err) {
    window.alert(`Could not record the decision.\n\n${err.message}`);
  } finally {
    state.deciding = false;
    renderCase();
    $("sec-verify")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/* ── 04 Verify / close ──────────────────────────────────────────── */

function renderVerify() {
  const sec = $("sec-verify");
  const inc = state.incident || {};
  const v = inc.verify_result;
  sec.hidden = !inc.decision;
  if (!inc.decision || !v) return;
  const hold = inc.decision === "hold";
  sec.dataset.tone = hold ? "info" : v.clears ? "ok" : "crit";
  $("verify-eyebrow").textContent = hold ? "Watch" : "Verify";
  $("verify-title").textContent = hold
    ? "Holding. ORBIT keeps watching."
    : v.result === "borderline"
      ? "Too close to call in the forecast."
      : v.clears
        ? "The forecast says the fix works."
        : "The forecast says the fix won't hold. Back to the evidence.";
  const unit = v.unit || "";
  const checks = [];
  if (v.simulated) {
    checks.push(`<li class="${v.clears ? "ok" : "bad"}"><span>${escapeHtml(v.text)} ${tagChip("SIMULATED")}</span></li>`);
    if (v.outcome?.recovered_in_s != null) {
      checks.push(`<li class="ok"><span>Back above warn ${v.outcome.recovered_in_s ? `in ${durText(v.outcome.recovered_in_s)}` : "at the first sample after the command"}, and still ${fmt(v.outcome.value_10min, 2)} ${escapeHtml(unit)} at ${v.outcome.clock_10min} ${tagChip("SIMULATED")}</span></li>`);
    }
  } else {
    checks.push(`<li><span>${escapeHtml(v.text)}</span></li>`);
  }
  if (v.step) checks.push(`<li class="${hold ? "info" : v.clears ? "ok" : "bad"}"><span>${escapeHtml(v.step)} ${tagChip("DOCUMENTED")}</span></li>`);
  if (inc.decision_note) checks.push(`<li class="info"><span>Reason: ${escapeHtml(inc.decision_note)} ${tagChip("OBSERVED")}</span></li>`);
  $("verify-checks").innerHTML = checks.join("");
  const close = $("close-case");
  const back = $("back-decide");
  const closed = isClosed();
  close.hidden = closed;
  back.hidden = closed || hold || v.clears;
  close.textContent = state.closing ? "Closing…" : v.clears ? "Close as confirmed" : hold ? "Close case" : "Close as unresolved";
  close.disabled = !!state.closing;
  $("verify-closed").hidden = !closed;
  if (closed) {
    $("verify-closed").innerHTML = `Closed ${escapeHtml((inc.filed_at || "").replace("T", " ").replace("Z", " UTC"))}. The close-out is in the audit trail below. <button type="button" class="text-btn" data-open-audit="closeout">Read close-out</button>`;
  }
}

async function closeCase() {
  if (!state.incidentId || state.closing) return;
  state.closing = true;
  renderVerify();
  try {
    const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(state.incidentId)}/file`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `file ${res.status}`);
    }
    const data = await res.json();
    state.incident = { ...state.incident, ...data.incident };
    applyIncidentPatch(state.incidentId, { status: "filed", filed_at: data.incident.filed_at });
    announceLive("Case closed.");
  } catch (err) {
    window.alert(`Could not close the case.\n\n${err.message}`);
  } finally {
    state.closing = false;
    renderCase();
  }
}

/* ── Audit trail ────────────────────────────────────────────────── */

const TRAIL_KIND = { first_warn: "read", events_before: "read", sample: "read", get_doc: "doc", ratio: "derive", classify: "derive", what_if: "sim", preview: "sim" };

function renderAudit() {
  const b = caseBrief();
  const sealed = b?.sealed;
  const runId = state.runId || "";
  const trail = b?.tool_trail || [];
  $("audit-stats").innerHTML = b
    ? `<span>${trail.length} steps</span><span id="audit-claims"></span><span class="ok">0 unsourced</span>`
    : `<span>not investigated</span>`;
  $("audit-seal").innerHTML = `
    <div><span class="k">Evidence window</span><span class="v mono">${escapeHtml(sealed?.id || runId)}</span></div>
    <div><span class="k">Time range</span><span class="v mono">${sealed?.clock0 ? `${sealed.clock0} → ${sealed.clock1} UTC` : escapeHtml(tapeSpan())}</span></div>
    <div><span class="k">Cut from tape</span><span class="v mono">${escapeHtml(sealed?.source || runId)}</span></div>
    <div><span class="k">Status</span><span class="v lock">Frozen at case open. Every measurement on this page reads from it; replays are tagged Simulated.</span></div>`;
  $("audit-trail").innerHTML = trail.length
    ? trail
        .map((s) => {
          const kind = TRAIL_KIND[s.tool] || "read";
          return `<li class="k-${kind}"><span class="tool">${escapeHtml(s.tool)}</span><span class="args">${escapeHtml(s.args)}</span><span class="out">${escapeHtml(s.out)}</span>${tagChip(s.tag)}</li>`;
        })
        .join("")
    : `<li class="muted">Run the investigation to record the tool trail.</li>`;
  renderProcedureBlock(b);
  const report = isClosed() && state.incident?.closeout ? state.incident.closeout : state.report;
  $("audit-report-title").textContent = isClosed() ? "Filed close-out" : "Full tagged report";
  $("audit-report").innerHTML = report ? renderMd(report) : `<p class="muted">No report yet.</p>`;
  requestAnimationFrame(tallyClaims);
}

function tapeSpan() {
  const rows = series(alarmChannel());
  return rows.length ? `${clock(rows[0].time_s)} → ${clock(rows[rows.length - 1].time_s)} UTC` : "";
}

function renderProcedureBlock(b) {
  const id = b?.facts?.procedure?.id;
  const proc = id ? PROC_BOOK[id] : null;
  $("audit-proc").hidden = !proc;
  if (!proc) return;
  const met = b.facts.procedure.step;
  $("audit-proc-title").textContent = `${id} · ${proc.title}`;
  $("audit-proc-steps").innerHTML = proc.steps
    .map((s) => `<li class="${s.n === met ? "is-key" : ""}${s.human ? " is-human" : ""}"><span class="n">${s.n}</span><span>${escapeHtml(s.label)}${s.n === met ? ` <b class="met">${escapeHtml(b.facts.procedure.sub)}</b>` : ""}${s.human ? ' <span class="muted">· operator</span>' : ""}</span></li>`)
    .join("");
}

function tallyClaims() {
  const root = $("case-desk");
  if (!root) return;
  const tags = [...root.querySelectorAll(".tag")].filter((t) => !t.closest("#audit") && t.offsetParent !== null);
  const kinds = [["observed", "OBSERVED"], ["derived", "DERIVED"], ["documented", "DOCUMENTED"], ["simulated", "SIMULATED"]];
  const counts = kinds.map(([k, n]) => [k, n, tags.filter((t) => t.classList.contains(`tag-${k}`)).length]).filter((x) => x[2]);
  const total = counts.reduce((s, x) => s + x[2], 0);
  $("audit-tally").innerHTML = counts.map(([k, n, c]) => `<span class="tally-${k}" style="flex:${c}">${n} ${c}</span>`).join("");
  const claims = $("audit-claims");
  if (claims) claims.textContent = `${total} tagged claims`;
}

/* ── render + events ────────────────────────────────────────────── */

function renderCase() {
  if (!state.workspace) return;
  $("case-desk").classList.toggle("has-brief", !!caseBrief());
  renderCaseHead();
  renderHappened();
  renderExplain();
  renderDecide();
  renderVerify();
  renderAudit();
}

function setCasePin(pin, key = null) {
  const same = key && state.casePinKey === key;
  state.casePin = same ? null : pin;
  state.casePinKey = same ? null : key;
  drawLanes();
  if (caseBrief()) drawBreakdown();
  renderLeadUp();
  document.querySelectorAll("#hyps .ev-line").forEach((li) => li.classList.toggle("is-on", li.dataset.evKey === state.casePinKey));
  if (!state.casePin) return;
  const target = state.casePin.part ? $("viz-breakdown") : $("viz-lanes");
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function bindCase() {
  const desk = $("case-desk");
  desk.addEventListener("click", (ev) => {
    const proof = ev.target.closest("[data-proof]");
    if (proof) {
      ev.stopPropagation();
      state.caseProofs = state.caseProofs || new Set();
      const key = proof.dataset.proof;
      if (state.caseProofs.has(key)) state.caseProofs.delete(key);
      else state.caseProofs.add(key);
      renderExplain();
      return;
    }
    const evLine = ev.target.closest("[data-ev-pin]");
    if (evLine && !ev.target.closest(".proof-slot")) {
      const [hid, idx] = evLine.dataset.evKey.split(":");
      const pin = caseBrief()?.hypotheses.find((h) => h.id === hid)?.evidence[Number(idx)]?.pin;
      if (pin) setCasePin(pin, evLine.dataset.evKey);
      return;
    }
    const toggle = ev.target.closest("[data-hyp-toggle]");
    if (toggle) {
      state.caseExpanded = state.caseExpanded || new Set();
      const id = toggle.dataset.hypToggle;
      if (state.caseExpanded.has(id)) state.caseExpanded.delete(id);
      else state.caseExpanded.add(id);
      renderExplain();
      return;
    }
    const lead = ev.target.closest("[data-case-pin]");
    if (lead) {
      const t = Number(lead.dataset.casePin);
      setCasePin({ t }, `lead:${t}`);
      return;
    }
    const opt = ev.target.closest("[data-option]");
    if (opt && !opt.disabled) {
      state.caseOption = opt.dataset.option;
      renderDecide();
      return;
    }
    if (ev.target.closest("#conf-toggle")) {
      state.confOpen = !state.confOpen;
      renderConfidence();
      return;
    }
    if (ev.target.closest("[data-go-sources]")) {
      ev.preventDefault();
      goSources();
      return;
    }
    if (ev.target.closest("#approve")) return approveDecision();
    if (ev.target.closest("#close-case")) return closeCase();
    if (ev.target.closest("#back-decide")) {
      $("sec-decide").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (ev.target.closest("#case-run")) return assemble();
    if (ev.target.closest("#case-inspect")) {
      openInspector({ runId: state.runId, channel: alarmChannel(), alarm: alarmChannel(), pinTimeS: state.casePin?.t ?? caseBrief()?.facts.alarm.t });
      return;
    }
    const audit = ev.target.closest("[data-open-audit]");
    if (audit) {
      $("audit").open = true;
      $("audit-report-wrap").open = true;
      $("audit").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  desk.addEventListener("keydown", (ev) => {
    if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches?.("[data-ev-pin]")) {
      ev.preventDefault();
      ev.target.click();
    }
  });
}

/* ── loading ────────────────────────────────────────────────────── */

async function openIncident(incidentId) {
  try {
    await loadIncident(incidentId);
  } catch (err) {
    $("case-lede").textContent = `Could not open ${incidentId}: ${err.message}`;
  }
}

async function loadIncident(incidentId) {
  state.incidentId = incidentId;
  state.incident = state.incidents.find((item) => item.id === incidentId) || null;
  state.runId = state.incident?.run_id || null;
  state.report = null;
  state.brief = null;
  state.casePin = null;
  state.casePinKey = null;
  state.caseOption = null;
  state.caseExpanded = null;
  state.caseProofs = new Set();
  state.workspace = null;
  enterCase();
  $("stage").scrollTop = 0;
  renderIncidents();
  const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(incidentId)}/workspace`));
  if (!res.ok) throw new Error(`workspace ${res.status}`);
  state.workspace = await res.json();
  state.incident = state.workspace.incident || state.incident;
  state.brief = state.workspace.brief || null;
  state.report = state.incident?.investigation_report || null;
  state.runId = state.workspace.run_id;
  renderCase();
}

async function runInvestigation(incidentId) {
  const id = incidentId || state.incidentId;
  if (!id || state.investigating) return;
  if (state.incidentId !== id || !state.workspace) await loadIncident(id);
  await assemble();
}

async function assemble() {
  if (!state.incidentId || state.investigating) return;
  state.investigating = true;
  renderCaseHead();
  $("case-desk").classList.add("is-investigating");
  try {
    const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(state.incidentId)}/investigate`), { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `investigate ${res.status}`);
    }
    const data = await res.json();
    state.report = data.report;
    state.brief = data.brief;
    state.caseExpanded = null;
    state.incident = { ...state.incident, status: data.status, investigation_report: data.report, investigated_at: data.investigated_at };
    applyIncidentPatch(state.incidentId, { status: data.status, investigation_report: data.report, investigated_at: data.investigated_at });
    announceLive("Investigation complete. Explanations and options are ready.");
  } catch (err) {
    announceLive(`Investigation failed. ${err.message}`);
    window.alert(`Investigation failed.\n\n${err.message}`);
  } finally {
    state.investigating = false;
    $("case-desk").classList.remove("is-investigating");
    renderCase();
    if (caseBrief()) $("sec-explain")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
