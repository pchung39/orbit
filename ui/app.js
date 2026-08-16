const ALARM = "EPS.bus_voltage";
const TRACE_ORDER = [
  { id: "EPS.bus_voltage", title: "Bus voltage", color: "var(--bus)", primary: true },
  { id: "THM.heater_b_current", title: "Heater B current", color: "var(--heater)" },
  { id: "PAY.payload_current", title: "Payload current", color: "var(--payload)" },
  { id: "EPS.bus_current", title: "Bus current", color: "var(--ink)" },
];

const RUN_COPY = {
  eps204: { kicker: "Canonical incident", title: "EPS-204", note: "Heater overcurrent + SCIENCE_MODE confounder" },
  fault1: { kicker: "Control", title: "Heater only", note: "Same fault, payload stays STANDBY" },
  inc0187: { kicker: "Prior day", title: "INC-0187 source", note: "Historical match for the search" },
};

const PROC_STEPS = [
  { id: "confirm", n: "1", label: "Confirm the alarm on EPS.bus_voltage. Note UTC." },
  { id: "commands", n: "2", label: "List commands and mode changes in the 10 minutes before the first warn." },
  { id: "currents", n: "3", label: "For each load enabled in that window, read current vs last healthy enable." },
  { id: "ratio", n: "4", label: "If a load is ≥2× its healthy draw, that load is the prime suspect." },
  { id: "payload", n: "5", label: "SCIENCE_MODE raises bus current but cannot explain a several-amp heater step. Check the heater before closing on the payload." },
  { id: "inhibit", n: "6", label: "Command the suspect load OFF and watch EPS.bus_voltage recover.", human: true },
];

const state = {
  runs: [],
  alarms: [],
  incidents: [],
  incidentId: null,
  incident: null,
  runId: null,
  workspace: null,
  window: "focus",
  pinT: null,
  hoverT: null,
  report: null,
  investigating: false,
};

const $ = (id) => document.getElementById(id);

function fmt(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(digits);
}

function clock(t) {
  if (t == null) return "--:--:--";
  const s = Math.round(t) % 86400;
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function alarmChannel() {
  return state.incident?.alarm || state.workspace?.alarm || ALARM;
}

function series(id) {
  return state.workspace?.telemetry?.[id] ?? [];
}

function meta(id) {
  return state.workspace?.channels?.[id] ?? {};
}

function sampleAt(rows, t) {
  if (!rows.length || t == null) return null;
  return rows.reduce((best, row) =>
    Math.abs(row.time_s - t) < Math.abs(best.time_s - t) ? row : best
  );
}

function firstCrossing(rows, limit, direction) {
  if (limit == null) return null;
  for (const row of rows) {
    const v = row.value_num;
    if (v == null) continue;
    if (direction === "below" && v < limit) return row;
    if (direction === "above" && v > limit) return row;
  }
  return null;
}

function analysis() {
  const ws = state.workspace;
  if (!ws) return null;
  const alarm = alarmChannel();
  const bus = series(alarm);
  const busMeta = meta(alarm);
  const warn = firstCrossing(bus, busMeta.warn_limit, busMeta.limit_direction);
  const t = warn?.time_s ?? bus.at(-1)?.time_s ?? null;
  const heater = sampleAt(series("THM.heater_b_current"), t);
  const payload = sampleAt(series("PAY.payload_current"), t);
  const busI = sampleAt(series("EPS.bus_current"), t);
  const mode = sampleAt(series("PAY.mode"), t);
  const heaterMeta = meta("THM.heater_b_current");
  const healthyMax = heaterMeta.nominal_range?.[1] ?? 1.2;
  const heaterA = heater?.value_num;
  const ratio = heaterA != null ? heaterA / healthyMax : null;
  const events = (ws.events || []).slice().sort((a, b) => a.time_s - b.time_s);
  const windowEvents = t == null
    ? events
    : events.filter((e) => e.time_s >= t - 600 && e.time_s <= t);
  const heaterCmd = events.find((e) => e.detail === "HEATER_B_ENABLE");
  const science = events.find((e) => e.detail === "SCIENCE_MODE");
  return {
    warn,
    t,
    heater,
    payload,
    busI,
    mode,
    heaterA,
    ratio,
    healthyMax,
    events,
    windowEvents,
    heaterCmd,
    science,
    suspect: ratio != null && ratio >= 2,
  };
}

function domain() {
  const a = analysis();
  const rows = series(alarmChannel());
  if (!rows.length) return [0, 1];
  const t0 = rows[0].time_s;
  const t1 = rows.at(-1).time_s;
  if (state.window === "full" || !a?.t) return [t0, t1];
  return [Math.max(t0, a.t - 8 * 60), Math.min(t1, a.t + 8 * 60)];
}

function inDomain(rows, [t0, t1]) {
  return rows.filter((r) => r.time_s >= t0 && r.time_s <= t1);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function stampTags(html) {
  return html.replace(/\[([A-Z /—-]+)\]/g, (_, raw) => {
    const key = raw.toLowerCase();
    const cls = key.includes("hypothesis")
      ? "hypothesis"
      : key.includes("derived")
        ? "derived"
        : key.includes("documented")
          ? "documented"
          : "observed";
    return `<span class="tag tag-${cls}">${escapeHtml(raw)}</span>`;
  });
}

function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return stampTags(s);
}

function renderMd(src) {
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;
  let list = null;
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.join("")}</${list.tag}>`);
    list = null;
  };
  const isTableSep = (line) => /^\s*\|?\s*-{3,}/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushList();
      i += 1;
      continue;
    }
    if (line.startsWith("# ")) {
      flushList();
      out.push(`<h3>${inlineMd(line.slice(2))}</h3>`);
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      out.push(`<h3>${inlineMd(line.slice(3))}</h3>`);
      i += 1;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushList();
      const cells = (row) => row.split("|").map((c) => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === "") && !(idx === arr.length - 1 && c === ""));
      const head = cells(line);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].includes("|")) {
        body.push(cells(lines[i]));
        i += 1;
      }
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(`<li>${inlineMd((ul || ol)[1])}</li>`);
      i += 1;
      continue;
    }
    flushList();
    out.push(`<p>${inlineMd(line)}</p>`);
    i += 1;
  }
  flushList();
  return out.join("");
}

function sectionTitle(block) {
  const m = block.match(/^#{1,2}\s+(.+)/);
  return m ? m[1].trim() : "";
}

function pullTags(raw) {
  const tags = [];
  const text = raw
    .replace(/\*\*\[([^\]]+)\]\*\*/g, (_, tag) => {
      tags.push(tag);
      return "";
    })
    .replace(/\[([A-Z /—-]+)\]/g, (_, tag) => {
      tags.push(tag);
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, tags };
}

function firstClock(text) {
  const m = text.match(/\b(\d{2}:\d{2}:\d{2})\b/);
  return m ? m[1] : "";
}

function clockToS(hhmmss) {
  const parts = hhmmss.split(":").map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function tagClass(tag) {
  const key = tag.toLowerCase();
  if (key.includes("hypothesis")) return "hypothesis";
  if (key.includes("derived")) return "derived";
  if (key.includes("documented")) return "documented";
  return "observed";
}

function tagsHtml(tags) {
  return tags
    .map((tag) => `<span class="tag tag-${tagClass(tag)}">${escapeHtml(tag)}</span>`)
    .join("");
}

function parseNumbered(block) {
  const items = [];
  for (const line of block.split("\n")) {
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      items.push({ n: Number(numbered[1]), raw: numbered[2], kids: [] });
      continue;
    }
    const kid = line.match(/^\s+-\s+(.*)$/);
    if (kid && items.length) items.at(-1).kids.push(kid[1]);
  }
  return items;
}

function parseKid(raw) {
  const clock = firstClock(raw);
  const rest = clock ? raw.replace(clock, "").trim() : raw;
  return { clock, html: inlineMd(rest) };
}

function itemKind(text, tags) {
  const blob = `${text} ${tags.join(" ")}`.toLowerCase();
  if (blob.includes("crossed warn") || blob.includes("warn at")) return "warn";
  if (blob.includes("derived")) return "derived";
  if (blob.includes("documented") && !blob.includes("observed")) return "documented";
  return "observed";
}

function renderLeadFinding(block) {
  const rows = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*-\s+\*\*(.+?):\*\*\s+(.*)$/) || line.match(/^\s*-\s+\*\*(.+?)\*\*:\s+(.*)$/);
    if (m) rows.push({ k: m[1], v: m[2] });
  }
  if (!rows.length) return `<article class="finding md">${renderMd(block)}</article>`;
  return `<article class="finding lead">
    <h3>${escapeHtml(sectionTitle(block) || "Investigation")}</h3>
    <dl class="lead-grid">
      ${rows
        .map((row) => `<div><dt>${escapeHtml(row.k)}</dt><dd>${inlineMd(row.v)}</dd></div>`)
        .join("")}
    </dl>
  </article>`;
}

function renderTimelineFinding(block) {
  const items = parseNumbered(block);
  const rows = items
    .map((item) => {
      const { text, tags } = pullTags(item.raw);
      const clock = firstClock(text) || firstClock(item.kids[0] || "");
      const kind = itemKind(text, tags);
      const pin = clock ? ` data-t="${clockToS(clock)}"` : "";
      const kids = item.kids
        .map((kid) => {
          const parsed = parseKid(kid);
          const kidPin = parsed.clock ? ` data-t="${clockToS(parsed.clock)}"` : "";
          return `<button type="button" class="ev-kid"${kidPin}>
            <span class="ev-clock">${parsed.clock || ""}</span>
            <span>${parsed.html}</span>
          </button>`;
        })
        .join("");
      return `<li class="ev-item ev-${kind}">
        <button type="button" class="ev-main"${pin}>
          <span class="ev-n">${String(item.n).padStart(2, "0")}</span>
          <span class="ev-clock">${clock || "—"}</span>
          <span class="ev-copy">${inlineMd(text)}</span>
          <span class="ev-tags">${tagsHtml(tags)}</span>
        </button>
        ${kids ? `<div class="ev-kids">${kids}</div>` : ""}
      </li>`;
    })
    .join("");
  return `<article class="finding evidence">
    <h3>Timeline</h3>
    <p class="hint">Same claims as the report. Click a row to pin that time on the traces.</p>
    <ol class="ev">${rows}</ol>
  </article>`;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const step = span / count;
  const mag = 10 ** Math.floor(Math.log10(step));
  const err = step / mag;
  const nice = err >= 7.5 ? 10 * mag : err >= 3 ? 5 * mag : err >= 1.5 ? 2 * mag : mag;
  const start = Math.ceil(min / nice) * nice;
  const ticks = [];
  for (let v = start; v <= max + nice * 0.01; v += nice) ticks.push(v);
  return ticks;
}

function pathFrom(points, x, y) {
  return points
    .map((p, i) => `${i ? "L" : "M"}${x(p.time_s).toFixed(2)} ${y(p.value_num).toFixed(2)}`)
    .join(" ");
}

const charts = {};

function drawTrace(el, channelId, title, color, primary) {
  const rows = series(channelId).filter((r) => r.value_num != null);
  const [t0, t1] = domain();
  const vis = inDomain(rows, [t0, t1]);
  const ch = meta(channelId);
  const a = analysis();
  const W = 920;
  const H = primary ? 148 : 118;
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const ys = vis.map((r) => r.value_num);
  let yMin = ys.length ? Math.min(...ys) : 0;
  let yMax = ys.length ? Math.max(...ys) : 1;
  if (ch.warn_limit != null) {
    yMin = Math.min(yMin, ch.warn_limit);
    yMax = Math.max(yMax, ch.warn_limit);
  }
  const padY = (yMax - yMin) * 0.12 || 0.2;
  yMin -= padY;
  yMax += padY;
  const x = (t) => pad.l + ((t - t0) / Math.max(t1 - t0, 1e-6)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / Math.max(yMax - yMin, 1e-6)) * (H - pad.t - pad.b);
  charts[channelId] = { t0, t1, x, y, pad, H, W, rows, color, unit: ch.unit || "" };
  const ticks = niceTicks(yMin, yMax, 3);
  const events = [
    ...(a?.events || []),
    ...(a?.warn ? [{ time_s: a.warn.time_s, detail: "WARN", kind: "warn" }] : []),
  ];
  const marks = events
    .filter((e) => e.time_s >= t0 && e.time_s <= t1)
    .map((e) => {
      const xx = x(e.time_s);
      const warn = e.kind === "warn" || e.detail?.includes("WARN");
      return `<line x1="${xx}" x2="${xx}" y1="${pad.t}" y2="${H - pad.b}" stroke="${warn ? "var(--warn)" : "var(--line-2)"}" stroke-dasharray="${warn ? "0" : "3 4"}" stroke-width="1"/>`;
    })
    .join("");
  const warnLine =
    ch.warn_limit != null
      ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(ch.warn_limit)}" y2="${y(ch.warn_limit)}" stroke="var(--warn)" stroke-dasharray="4 4" stroke-width="1" opacity="0.85"/>`
      : "";
  const d = vis.length ? pathFrom(vis, x, y) : "";
  const area = vis.length
    ? `${d} L${x(vis.at(-1).time_s).toFixed(2)} ${H - pad.b} L${x(vis[0].time_s).toFixed(2)} ${H - pad.b} Z`
    : "";
  const yLabels = ticks
    .map((v) => `<text x="${pad.l - 6}" y="${y(v) + 3}" text-anchor="end" fill="var(--mute)" font-size="10" font-family="IBM Plex Mono, ui-monospace, monospace">${fmt(v, Math.abs(v) >= 10 ? 0 : 1)}</text>`)
    .join("");
  el.innerHTML = `
    <div class="trace-head">
      <h3>${title}</h3>
      <span class="now">—</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
      ${yLabels}
      ${warnLine}
      ${marks}
      ${area ? `<path d="${area}" fill="${color}" opacity="0.12"></path>` : ""}
      ${d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"></path>` : ""}
      <g class="hover-g"></g>
      <text x="${pad.l}" y="${H - 6}" fill="var(--mute)" font-size="10" font-family="IBM Plex Mono, ui-monospace, monospace">${clock(t0)}</text>
      <text x="${W - pad.r}" y="${H - 6}" text-anchor="end" fill="var(--mute)" font-size="10" font-family="IBM Plex Mono, ui-monospace, monospace">${clock(t1)}</text>
      <rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent"/>
    </svg>
  `;
  const hit = el.querySelector(".hit");
  hit.addEventListener("mousemove", (ev) => {
    const rect = hit.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    state.hoverT = t0 + frac * (t1 - t0);
    updateReadouts();
  });
  hit.addEventListener("mouseleave", () => {
    state.hoverT = null;
    updateReadouts();
  });
  hit.addEventListener("click", () => {
    state.pinT = state.hoverT;
    renderTimeline(analysis());
    updateReadouts();
  });
}

function updateReadouts() {
  const a = analysis();
  const t = state.hoverT ?? state.pinT ?? a?.t;
  $("focus-clock").textContent = clock(t);
  const parts = TRACE_ORDER.map((ch) => {
    const row = sampleAt(series(ch.id), t);
    const unit = meta(ch.id).unit || "";
    return `${ch.title} ${fmt(row?.value_num)} ${unit}`;
  });
  $("hover-read").textContent = t != null ? `${clock(t)}  ·  ${parts.join("   ")}` : "";
  TRACE_ORDER.forEach((spec) => {
    const el = document.querySelector(`[data-ch="${spec.id}"]`);
    const c = charts[spec.id];
    if (!el || !c) return;
    const now = sampleAt(c.rows, t);
    const unit = c.unit;
    el.querySelector(".now").textContent = now ? `${fmt(now.value_num)} ${unit}` : "—";
    const g = el.querySelector(".hover-g");
    if (t == null) {
      g.innerHTML = "";
      return;
    }
    const xx = c.x(t);
    const cy = now ? c.y(now.value_num) : c.pad.t;
    g.innerHTML = `<line x1="${xx}" x2="${xx}" y1="${c.pad.t}" y2="${c.H - c.pad.b}" stroke="var(--ink)" stroke-width="1" opacity="0.35"/>${
      now ? `<circle cx="${xx}" cy="${cy}" r="3.2" fill="${c.color}"/>` : ""
    }`;
  });
}

function renderIncidents() {
  $("incidents").innerHTML = state.incidents
    .map((item) => {
      return `<button type="button" class="run ${item.id === state.incidentId ? "is-on" : ""}" data-incident="${item.id}">
        <span class="id">${item.id}</span>
        <span class="note">${escapeHtml(item.title)} · ${escapeHtml(item.alarm)}</span>
      </button>`;
    })
    .join("");
}

function nextIncidentPreview() {
  let n = 204;
  for (const item of state.incidents) {
    const suffix = String(item.id).replace(/^INC-/, "");
    if (/^\d+$/.test(suffix)) n = Math.max(n, Number(suffix) + 1);
  }
  return `INC-${String(n).padStart(4, "0")}`;
}

function setPick(kind, value) {
  const hidden = $(kind === "alarm" ? "incident-alarm-value" : "incident-run-value");
  const root = $(kind === "alarm" ? "incident-alarm" : "incident-run");
  hidden.value = value;
  root.querySelectorAll(".pick").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.value === value);
  });
}

function fillCreateForm() {
  $("slip-id").textContent = nextIncidentPreview();
  $("incident-alarm").innerHTML = state.alarms
    .map(
      (ch) => `<button type="button" class="pick" data-pick="alarm" data-value="${escapeHtml(ch.id)}">
        <span class="k">${escapeHtml(ch.id)}</span>
        <span class="note">${ch.warn_limit} ${ch.unit || ""}</span>
      </button>`
    )
    .join("");
  $("incident-run").innerHTML = state.runs
    .map(
      (run) => `<button type="button" class="pick" data-pick="run" data-value="${escapeHtml(run.id)}">
        <span class="k">${escapeHtml(run.id)}</span>
        <span class="note">${escapeHtml(run.notes || "Telemetry tape")}</span>
      </button>`
    )
    .join("");
  const alarm = $("incident-alarm-value").value || ALARM;
  const run = $("incident-run-value").value || (state.runs.find((r) => r.id === "eps204") || state.runs[0])?.id || "";
  if (state.alarms.some((ch) => ch.id === alarm)) setPick("alarm", alarm);
  else if (state.alarms[0]) setPick("alarm", state.alarms[0].id);
  if (state.runs.some((r) => r.id === run)) setPick("run", run);
  else if (state.runs[0]) setPick("run", state.runs[0].id);
}

function openSlip() {
  fillCreateForm();
  $("slip").hidden = false;
}

function closeSlip() {
  $("slip").hidden = true;
}

function setStoreStatus(ok) {
  const el = $("store-status");
  el.classList.toggle("is-on", ok);
  el.classList.toggle("is-empty", !ok);
  el.innerHTML = `<span class="pulse"></span> ${ok ? "Connected" : "Empty"}`;
}

function renderAlarm(a) {
  const hero = $("alarm");
  const inc = state.incident;
  const alarm = alarmChannel();
  $("alarm-kicker").textContent = inc ? inc.status || "open" : "Incident";
  $("alarm-title").textContent = inc?.title || inc?.id || "Select an incident";
  $("case-meta").textContent = inc
    ? `${inc.id}  ·  Aurora-1  ·  ${inc.run_id}  ·  ${inc.alarm}`
    : "";
  if (!a) {
    $("alarm-lede").textContent = "Open an incident from an alarm you already have. ORBIT does not detect anomalies.";
    $("alarm-value").textContent = "—";
    $("alarm-unit").textContent = "";
    $("alarm-limit").textContent = "";
    hero.classList.remove("is-warn", "is-ok");
    return;
  }
  const v = a.warn?.value_num ?? sampleAt(series(alarm), a.t)?.value_num;
  const ch = meta(alarm);
  const crossed = Boolean(a.warn);
  $("alarm-lede").textContent = crossed
    ? `${alarm} crossed warn at ${clock(a.warn.time_s)} (${fmt(v, 2)} ${ch.unit || ""}).`
    : `No ${alarm} warn in this telemetry. Entry still stands — you opened from an alarm you already had.`;
  $("alarm-value").textContent = fmt(v, 2);
  $("alarm-unit").textContent = ch.unit || "";
  $("alarm-limit").textContent = crossed
    ? `WARN  ${clock(a.warn.time_s)}  ·  limit ${fmt(ch.warn_limit, 1)} ${ch.unit || ""}`
    : ch.warn_limit != null
      ? `limit ${fmt(ch.warn_limit, 1)} ${ch.unit || ""}`
      : "";
  hero.classList.toggle("is-warn", crossed);
  hero.classList.toggle("is-ok", !crossed);
}

function renderCompare(a) {
  const root = $("compare-grid");
  if (!a) {
    root.innerHTML = "";
    return;
  }
  const cards = [
    {
      k: "Heater B",
      v: a.heaterA,
      unit: "A",
      why: `Healthy ON is ${fmt(meta("THM.heater_b_current").nominal_range?.[0], 1)}–${fmt(a.healthyMax, 1)} A.`,
      ratio: a.ratio != null ? `${fmt(a.ratio, 1)}× healthy max` : "",
      cls: a.suspect ? "suspect" : "",
    },
    {
      k: "Payload",
      v: a.payload?.value_num,
      unit: "A",
      why: a.science
        ? `SCIENCE_MODE at ${clock(a.science.time_s)} — looks guilty, draws < 1 A.`
        : "Payload never left STANDBY in this run.",
      ratio: a.mode?.value_text || "",
      cls: "confounder",
    },
    {
      k: "Bus current",
      v: a.busI?.value_num,
      unit: "A",
      why: `Warn at ${fmt(meta("EPS.bus_current").warn_limit, 1)} A. Sum of loads, not a cause.`,
      ratio: "",
      cls: "",
    },
  ];
  root.innerHTML = cards
    .map(
      (c) => `<article class="card ${c.cls}">
        <p class="k">${c.k}</p>
        <p class="v">${fmt(c.v, 2)}<small>${c.unit}</small></p>
        ${c.ratio ? `<p class="ratio">${escapeHtml(c.ratio)}</p>` : ""}
        <p class="why">${escapeHtml(c.why)}</p>
      </article>`
    )
    .join("");
}

function renderTimeline(a) {
  const root = $("timeline");
  if (!a) {
    root.innerHTML = "";
    return;
  }
  const items = [
    ...a.windowEvents.map((e) => ({
      t: e.time_s,
      title: e.detail,
      sub: `${e.event_type} · ${e.channel || ""}`,
      warn: false,
    })),
  ];
  if (a.warn) {
    items.push({
      t: a.warn.time_s,
      title: "EPS.bus_voltage WARN",
      sub: `${fmt(a.warn.value_num, 2)} V · first crossing`,
      warn: true,
    });
  }
  items.sort((x, y) => x.t - y.t);
  const pin = state.pinT;
  root.innerHTML = items
    .map((item) => {
      const on = pin != null && Math.abs(pin - item.t) < 3;
      return `<li>
        <span class="t-clock">${clock(item.t)}</span>
        <span class="t-dot ${item.warn ? "warn" : ""}"></span>
        <button type="button" class="t-card ${on ? "is-on" : ""}" data-t="${item.t}">
          <strong>${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.sub)}</span>
        </button>
      </li>`;
    })
    .join("") || `<li><span class="t-clock"></span><span class="t-dot"></span><p class="empty">No commands in the window.</p></li>`;
}

function renderMode(a) {
  const rows = series("PAY.mode");
  const [t0, t1] = domain();
  const vis = inDomain(rows, [t0, t1]);
  if (!vis.length) {
    $("mode-strip").innerHTML = "";
    return;
  }
  const W = 920;
  const padL = 44;
  const padR = 12;
  const x = (t) => padL + ((t - t0) / Math.max(t1 - t0, 1e-6)) * (W - padL - padR);
  let html = "";
  for (let i = 0; i < vis.length; i += 1) {
    const cur = vis[i];
    const next = vis[i + 1];
    const x1 = x(cur.time_s);
    const x2 = x(next ? next.time_s : t1);
    const science = cur.value_text === "SCIENCE_MODE";
    html += `<rect x="${x1}" y="4" width="${Math.max(x2 - x1, 0.8)}" height="10" fill="${science ? "var(--payload)" : "var(--line-2)"}" opacity="${science ? 0.55 : 0.9}"/>`;
  }
  $("mode-strip").innerHTML = `<svg viewBox="0 0 ${W} 18" preserveAspectRatio="none" aria-label="Payload mode">
    <text x="0" y="13" fill="var(--mute)" font-size="10" font-family="var(--sans)">PAY.mode</text>
    ${html}
  </svg>`;
}

function renderTraces() {
  const root = $("trace-stack");
  const a = analysis();
  $("trace-caption").textContent = a?.warn
    ? `Shared time axis · pin ${clock(state.pinT ?? a.t)} · dashed lines are commands, solid amber is the first warn.`
    : "Shared time axis.";
  root.innerHTML = TRACE_ORDER.map(
    (t) => `<article class="trace ${t.primary ? "primary" : ""}" data-ch="${t.id}"></article>`
  ).join("");
  TRACE_ORDER.forEach((t) => {
    const el = root.querySelector(`[data-ch="${t.id}"]`);
    drawTrace(el, t.id, t.title, t.color, t.primary);
  });
  updateReadouts();
}

function renderProc(a) {
  const status = {
    confirm: a?.warn ? "Satisfied" : "",
    commands: a?.windowEvents.length ? "Satisfied" : "",
    currents: a?.heaterA != null ? "Satisfied" : "",
    ratio: a?.suspect ? "Satisfied" : "",
    payload: a ? "Satisfied" : "",
    inhibit: a?.suspect ? "Not sent" : "",
  };
  $("proc").innerHTML = PROC_STEPS.map((step) => {
    const label = status[step.id];
    const done = label === "Satisfied";
    const human = step.human && Boolean(label);
    return `<li class="${done ? "is-done" : ""} ${human ? "is-action" : ""}">
      <span class="proc-n">${step.n}</span>
      <span class="proc-text">${escapeHtml(step.label)}</span>
      <span class="proc-state">${escapeHtml(label)}</span>
    </li>`;
  }).join("");
}

function renderDecision(a) {
  const status = $("decide-meta");
  if (!a) {
    $("decide-title").textContent = "None yet";
    $("decide-sub").textContent = "Select a case to see a recommended next step.";
    status.textContent = "";
    return;
  }
  if (a.suspect) {
    $("decide-title").textContent = "Inhibit Heater B";
    $("decide-sub").textContent = "Then watch EPS.bus_voltage recover. Leave the payload as-is unless the bus does not come back.";
    status.textContent = "Not sent";
    return;
  }
  if (!a.warn) {
    $("decide-title").textContent = "No action";
    $("decide-sub").textContent = "No bus-voltage warn on this case.";
    status.textContent = "";
    return;
  }
  $("decide-title").textContent = "Keep reading";
  $("decide-sub").textContent = "Heater current is not ≥2× healthy.";
  status.textContent = "";
}

function renderFindings() {
  const body = $("findings-body");
  const btn = $("assemble");
  btn.disabled = state.investigating || !state.incidentId;
  btn.textContent = state.investigating ? "Assembling…" : "Assemble EPS-17 report";
  if (state.report) {
    const sections = state.report.split(/\n(?=## )/);
    body.innerHTML = sections
      .filter((block) => {
        const title = sectionTitle(block.trim());
        return !/^tool log$/i.test(title) && !/^hypothesis$/i.test(title) && !/decision/i.test(title);
      })
      .map((raw) => {
        const block = raw.trim();
        const title = sectionTitle(block);
        if (/^# [^#]/.test(block)) return renderLeadFinding(block);
        if (/^timeline$/i.test(title)) return renderTimelineFinding(block);
        return `<article class="finding md">${renderMd(block)}</article>`;
      })
      .join("");
    return;
  }
  const a = analysis();
  if (!a) {
    body.innerHTML = `<p class="empty">Load a run to begin.</p>`;
    return;
  }
  body.innerHTML = `<p class="empty">The traces already show the story. Assemble the tagged EPS-17 report when you want the same evidence stamped OBSERVED / DERIVED / DOCUMENTED / HYPOTHESIS. Rules only — no paid model.</p>`;
}

function renderCase() {
  const a = analysis();
  renderAlarm(a);
  renderCompare(a);
  renderTimeline(a);
  renderMode(a);
  renderTraces();
  renderProc(a);
  renderDecision(a);
  renderFindings();
}

async function loadIncident(incidentId) {
  state.incidentId = incidentId;
  state.incident = state.incidents.find((item) => item.id === incidentId) || null;
  state.runId = state.incident?.run_id || null;
  state.report = null;
  state.pinT = null;
  state.hoverT = null;
  renderIncidents();
  const res = await fetch(`/incidents/${encodeURIComponent(incidentId)}/workspace`);
  if (!res.ok) throw new Error(`workspace ${res.status}`);
  state.workspace = await res.json();
  if (state.workspace.incident) state.incident = state.workspace.incident;
  state.runId = state.workspace.run_id;
  const a = analysis();
  state.pinT = a?.warn?.time_s ?? a?.heaterCmd?.time_s ?? null;
  renderCase();
}

async function assemble() {
  if (!state.incidentId || state.investigating) return;
  state.investigating = true;
  renderFindings();
  try {
    const res = await fetch(`/incidents/${encodeURIComponent(state.incidentId)}/investigate`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`investigate ${res.status}`);
    const data = await res.json();
    state.report = data.report;
  } catch (err) {
    state.report = `# Could not assemble\n\n${err.message}`;
  } finally {
    state.investigating = false;
    renderFindings();
    $("findings").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function createIncident(ev) {
  ev.preventDefault();
  const form = $("new-incident");
  const body = {
    run_id: form.run_id.value,
    alarm: form.alarm.value,
    title: form.title.value.trim() || null,
  };
  if (!body.run_id || !body.alarm) {
    window.alert("Pick a tape and an entry alarm first.");
    return;
  }
  const res = await fetch("/incidents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    window.alert(err.detail || "Could not open incident");
    return;
  }
  const created = await res.json();
  state.incidents = [created, ...state.incidents.filter((item) => item.id !== created.id)];
  closeSlip();
  form.reset();
  fillCreateForm();
  await loadIncident(created.id);
}

async function openDoc(id) {
  const res = await fetch(`/documents/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const doc = await res.json();
  $("reader-kind").textContent = doc.kind;
  $("reader-title").textContent = doc.title;
  $("reader-body").innerHTML = renderMd(doc.body);
  $("reader").hidden = false;
}

function closeReader() {
  $("reader").hidden = true;
}

function bind() {
  $("incidents").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-incident]");
    if (btn) loadIncident(btn.dataset.incident);
  });
  $("new-incident-btn").addEventListener("click", openSlip);
  $("cancel-incident").addEventListener("click", closeSlip);
  $("slip").addEventListener("click", (ev) => {
    if (ev.target.id === "slip") closeSlip();
  });
  $("incident-alarm").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-pick=alarm]");
    if (btn) setPick("alarm", btn.dataset.value);
  });
  $("incident-run").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-pick=run]");
    if (btn) setPick("run", btn.dataset.value);
  });
  $("new-incident").addEventListener("submit", createIncident);
  $("timeline").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-t]");
    if (!btn) return;
    state.pinT = Number(btn.dataset.t);
    renderCase();
  });
  $("findings-body").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-t]");
    if (!btn) return;
    state.pinT = Number(btn.dataset.t);
    renderCase();
    $("traces").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.querySelector(".seg").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-window]");
    if (!btn) return;
    state.window = btn.dataset.window;
    document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("is-on", b === btn));
    renderCase();
  });
  $("assemble").addEventListener("click", assemble);
  $("open-eps17").addEventListener("click", () => openDoc("EPS-17"));
  $("reader-close").addEventListener("click", closeReader);
  $("reader").addEventListener("click", (ev) => {
    if (ev.target.id === "reader") closeReader();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!$("slip").hidden) {
      closeSlip();
      return;
    }
    closeReader();
  });
}

async function boot() {
  bind();
  const [runsRes, incidentRes, alarmRes] = await Promise.all([
    fetch("/runs"),
    fetch("/incidents"),
    fetch("/entry-alarms"),
  ]);
  state.runs = await runsRes.json();
  state.incidents = await incidentRes.json();
  state.alarms = await alarmRes.json();
  setStoreStatus(state.runs.length > 0);
  fillCreateForm();
  renderIncidents();
  const preferred = state.incidents.find((item) => item.id === "INC-0204") || state.incidents[0];
  if (preferred) await loadIncident(preferred.id);
}

boot().catch((err) => {
  $("alarm-title").textContent = "Store unreachable";
  $("alarm-lede").textContent = err.message;
});
