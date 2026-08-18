const ALARM = "EPS.bus_voltage";
const TRACE_CATALOG = [
  { id: "EPS.bus_voltage", title: "Bus voltage", color: "var(--bus)" },
  { id: "EPS.battery_voltage", title: "Battery voltage", color: "var(--accent)" },
  { id: "THM.heater_b_current", title: "Heater B current", color: "var(--heater)" },
  { id: "PAY.payload_current", title: "Payload current", color: "var(--payload)" },
  { id: "EPS.bus_current", title: "Bus current", color: "var(--ink)" },
  { id: "EPS.solar_array_current", title: "Solar array current", color: "var(--mute)" },
];

const TAPE_ORDER = ["eps204", "fault1", "pay002", "batt003", "nominal", "inc0187", "inc0191", "inc0162"];

const RUN_COPY = {
  eps204: { kind: "Demo", title: "Heater + confounder", note: "Heater 3×. SCIENCE_MODE makes the payload look guilty." },
  fault1: { kind: "Control", title: "Heater only", note: "Same heater fault. Payload stayed STANDBY." },
  pay002: { kind: "Contrast", title: "Payload spike", note: "Payload 3× on SCIENCE_MODE. Do not inhibit the heater." },
  batt003: { kind: "Contrast", title: "Pack IR sag", note: "Battery sagged. Heater current is healthy." },
  nominal: { kind: "Healthy", title: "Science pass", note: "SCIENCE_MODE at ~0.9 A. No warn on this tape." },
  inc0187: { kind: "Prior", title: "INC-0187 source", note: "Library match for the heater close." },
  inc0191: { kind: "Prior", title: "INC-0191 source", note: "Library match for the payload close." },
  inc0162: { kind: "Prior", title: "INC-0162 source", note: "Library match for the pack-IR close." },
};

const LIB_COPY = {
  "EPS-17": {
    use: "Bus voltage warn. Check the load that just came on.",
    close: "Inhibit the load at ≥2×",
    family: "heater",
  },
  "PAY-04": {
    use: "Payload current ≥2× science. Heater is not the fault.",
    close: "Safe payload to STANDBY",
    family: "payload",
  },
  "EPS-09": {
    use: "Pack sag. Heater and payload currents are healthy.",
    close: "No inhibit · battery checkout",
    family: "battery",
  },
  "INC-0187": {
    use: "Same heater fault. Payload was idle.",
    close: "Inhibit Heater B",
    family: "heater",
  },
  "INC-0191": {
    use: "Same payload fault. Heater was idle.",
    close: "Safe payload · leave heater",
    family: "payload",
  },
  "INC-0162": {
    use: "Pack sagged. Heater current was healthy.",
    close: "No inhibit",
    family: "battery",
  },
};

function incidentTone(item) {
  if (item.alarm === "PAY.payload_current") return "payload";
  if (item.alarm === "EPS.battery_voltage") return "battery";
  if (item.alarm === "EPS.bus_voltage") return "bus";
  return "other";
}

function alarmShort(alarm) {
  if (alarm === "EPS.bus_voltage") return "Bus V";
  if (alarm === "PAY.payload_current") return "Payload I";
  if (alarm === "EPS.battery_voltage") return "Battery V";
  return String(alarm || "").split(".").pop() || "Alarm";
}

function alarmTitle(alarm) {
  const ch = TRACE_CATALOG.find((row) => row.id === alarm);
  return ch ? ch.title : alarmShort(alarm);
}

function statusLabel(status) {
  if (status === "recommended") return "Ready";
  if (status === "filed") return "Filed";
  return "Open";
}

function statusRank(status) {
  if (status === "recommended") return 0;
  if (status === "filed") return 2;
  return 1;
}

function openedClock(iso) {
  const m = String(iso || "").match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

function caseAction(item) {
  if (item.alarm === "PAY.payload_current") return "Safe payload to STANDBY";
  if (item.alarm === "EPS.battery_voltage") return "No inhibit";
  if (item.alarm === "EPS.bus_voltage") return "Inhibit Heater B";
  return "";
}

function tapeCopy(run) {
  return RUN_COPY[run.id] || { kind: "Tape", title: run.id, note: run.notes || "Telemetry tape" };
}

function sortTapes(runs) {
  return [...runs].sort((a, b) => {
    const ia = TAPE_ORDER.indexOf(a.id);
    const ib = TAPE_ORDER.indexOf(b.id);
    const ra = ia === -1 ? 100 : ia;
    const rb = ib === -1 ? 100 : ib;
    return ra - rb || a.id.localeCompare(b.id);
  });
}

const PROC_BOOK = {
  "EPS-17": {
    title: "EPS low-voltage response",
    aka: "Check recently activated nonessential loads",
    applies: "Aurora-1 Electrical Power System",
    entry: "<code>EPS.bus_voltage</code> at or below warn (26.5 V)",
    goal: "Find the load that just came on. Do not guess the payload first.",
    steps: [
      { id: "confirm", n: "1", label: "Confirm the alarm on EPS.bus_voltage. Note UTC." },
      { id: "commands", n: "2", label: "List commands and mode changes in the 10 minutes before the first warn." },
      { id: "currents", n: "3", label: "For each load enabled in that window, read current vs last healthy enable." },
      { id: "ratio", n: "4", label: "If a load is ≥2× its healthy draw, that load is the prime suspect." },
      { id: "payload", n: "5", label: "SCIENCE_MODE raises bus current but cannot explain a several-amp heater step. Check the heater before closing on the payload." },
      { id: "action", n: "6", label: "Command the suspect load OFF and watch EPS.bus_voltage recover.", human: true },
    ],
  },
  "PAY-04": {
    title: "Payload power spike",
    aka: "Safe SCIENCE_MODE if draw is ≥2× healthy",
    applies: "Aurora-1 payload",
    entry: "<code>PAY.payload_current</code> at or above warn (1.1 A)",
    goal: "Confirm the payload itself is overcurrent. Do not inhibit a healthy heater.",
    steps: [
      { id: "confirm", n: "1", label: "Confirm the alarm on PAY.payload_current. Note UTC." },
      { id: "commands", n: "2", label: "Confirm PAY.mode is SCIENCE_MODE and note when it entered." },
      { id: "currents", n: "3", label: "Read payload current vs the healthy science baseline (~0.9 A)." },
      { id: "ratio", n: "4", label: "If payload current is ≥2× the 0.9 A baseline, the payload is the prime suspect." },
      { id: "payload", n: "5", label: "Read heater current. If it is not ≥2× healthy ON, do not inhibit Heater B." },
      { id: "action", n: "6", label: "Command the payload back to STANDBY and watch PAY.payload_current fall.", human: true },
    ],
  },
  "EPS-09": {
    title: "Battery voltage sag",
    aka: "Checkout pack IR before inhibiting loads",
    applies: "Aurora-1 Electrical Power System — battery pack",
    entry: "<code>EPS.battery_voltage</code> at or below warn (25.5 V)",
    goal: "Decide whether the pack is sagging under a healthy load. Do not inhibit that load.",
    steps: [
      { id: "confirm", n: "1", label: "Confirm the alarm on EPS.battery_voltage. Note UTC." },
      { id: "commands", n: "2", label: "List commands in the 10 minutes before the first warn." },
      { id: "currents", n: "3", label: "Read heater and payload current at the warn." },
      { id: "ratio", n: "4", label: "If a load is ≥2× healthy, stop and go to EPS-17 or PAY-04." },
      { id: "payload", n: "5", label: "If both currents are healthy, do not inhibit them. The sag is on the pack." },
      { id: "action", n: "6", label: "Continue battery checkout offline. ORBIT does not send a command.", human: true },
    ],
  },
};

function tracesToDraw() {
  const alarm = alarmChannel();
  return TRACE_CATALOG.map((ch) => ({ ...ch, primary: ch.id === alarm }));
}

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
  filing: false,
  docs: [],
  libraryQuery: "",
  libraryHits: null,
  librarySearching: false,
  libraryPinned: false,
  libraryOpen: true,
  openDocId: null,
  openDoc: null,
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
  const payloadMeta = meta("PAY.payload_current");
  const payloadHealthy = payloadMeta.nominal_range?.[1] ?? 0.9;
  const payloadA = payload?.value_num;
  const payloadRatio = payloadA != null ? payloadA / payloadHealthy : null;
  const events = (ws.events || []).slice().sort((a, b) => a.time_s - b.time_s);
  const windowEvents = t == null
    ? events
    : events.filter((e) => e.time_s >= t - 600 && e.time_s <= t);
  const heaterCmd = events.find((e) => e.detail === "HEATER_B_ENABLE");
  const science = events.find((e) => e.detail === "SCIENCE_MODE");
  const suspect = ratio != null && ratio >= 2;
  const payloadSuspect = !suspect && payloadRatio != null && payloadRatio >= 2;
  const battRows = series("EPS.battery_voltage");
  const battMeta = meta("EPS.battery_voltage");
  const battWarn = firstCrossing(battRows, battMeta.warn_limit, battMeta.limit_direction);
  const batterySuspect = !suspect && !payloadSuspect && (alarm === "EPS.battery_voltage" || Boolean(battWarn));
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
    payloadA,
    payloadRatio,
    payloadHealthy,
    events,
    windowEvents,
    heaterCmd,
    science,
    suspect,
    payloadSuspect,
    batterySuspect,
    battWarn,
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

function procedureId(a) {
  if (a?.suspect) return "EPS-17";
  if (a?.payloadSuspect) return "PAY-04";
  if (a?.batterySuspect) return "EPS-09";
  return "EPS-17";
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
  const parts = tracesToDraw().map((ch) => {
    const row = sampleAt(series(ch.id), t);
    const unit = meta(ch.id).unit || "";
    return `${ch.title} ${fmt(row?.value_num)} ${unit}`;
  });
  $("hover-read").textContent = t != null ? `${clock(t)}  ·  ${parts.join("   ")}` : "";
  tracesToDraw().forEach((spec) => {
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
  const byTime = (a, b) =>
    statusRank(a.status) - statusRank(b.status) || String(b.opened_at || "").localeCompare(String(a.opened_at || ""));
  const open = state.incidents.filter((item) => item.status !== "filed").sort(byTime);
  const filed = state.incidents.filter((item) => item.status === "filed").sort(byTime);
  const row = (item) => {
    const st = item.status || "open";
    const clock = openedClock(item.opened_at);
    const action = st === "open" ? "" : caseAction(item);
    const on = item.id === state.incidentId ? "is-on" : "";
    return `<button type="button" class="run tone-${incidentTone(item)} ${on} ${st === "filed" ? "is-filed" : ""}" data-incident="${item.id}">
      <span class="run-top">
        <span class="id">${item.id}</span>
        <span class="chip chip-${st === "recommended" ? "ready" : escapeHtml(st)}">${statusLabel(st)}</span>
      </span>
      <span class="run-mid">${escapeHtml(alarmShort(item.alarm))}${clock ? ` · ${clock}` : ""}</span>
      ${action ? `<span class="run-act">${escapeHtml(action)}</span>` : ""}
    </button>`;
  };
  const openBlock = open.length
    ? open.map(row).join("")
    : `<p class="lib-hint">No open cases.</p>`;
  const filedBlock = filed.length
    ? `<section class="desk-filed"><p class="family-head">Filed <span class="n">${filed.length}</span></p>${filed.map(row).join("")}</section>`
    : "";
  $("incidents").innerHTML = openBlock + filedBlock;
  const meta = $("queue-meta");
  if (meta) meta.textContent = open.length ? String(open.length) : "";
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
      (ch) => `<button type="button" class="pick pick-alarm" data-pick="alarm" data-value="${escapeHtml(ch.id)}">
        <span class="k">${escapeHtml(ch.id)}</span>
        <span class="note">warn ${ch.warn_limit} ${ch.unit || ""}</span>
      </button>`
    )
    .join("");
  $("incident-run").innerHTML = sortTapes(state.runs)
    .map((run) => {
      const copy = tapeCopy(run);
      return `<button type="button" class="pick pick-tape" data-pick="run" data-value="${escapeHtml(run.id)}">
        <span class="pick-top">
          <span class="kind">${escapeHtml(copy.kind)}</span>
          <span class="k">${escapeHtml(run.id)}</span>
        </span>
        <span class="title">${escapeHtml(copy.title)}</span>
        <span class="note">${escapeHtml(copy.note)}</span>
      </button>`;
    })
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

function openFileSlip() {
  if (!state.incidentId || state.incident?.status === "filed") return;
  $("file-slip-id").textContent = state.incident?.id || "INC-····";
  $("file-slip-action").textContent = $("decide-title").textContent || "Recommended action";
  $("file-note").value = "";
  $("file-slip").hidden = false;
  $("file-note").focus();
}

function closeFileSlip() {
  $("file-slip").hidden = true;
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
  const st = inc?.status || "";
  $("alarm-kicker").textContent = inc ? inc.id : "Case";
  const chip = $("status-chip");
  if (st) {
    chip.hidden = false;
    chip.className = `chip chip-${st === "recommended" ? "ready" : st}`;
    chip.textContent = statusLabel(st);
  } else {
    chip.hidden = true;
  }
  document.body.classList.toggle("is-filed", st === "filed");
  const banner = $("filed-banner");
  banner.hidden = st !== "filed";
  if (st === "filed") {
    const n = (inc.notes || "").trim();
    $("filed-banner-copy").textContent =
      n && !n.startsWith("Canonical")
        ? n
        : "Decision recorded. The recommended command was not sent.";
  }
  $("alarm-title").textContent = inc ? alarmTitle(inc.alarm) : "Select a case";
  const when = a?.warn ? clock(a.warn.time_s) : openedClock(inc?.opened_at);
  $("case-meta").textContent = inc && when ? when : "";
  if (!a) {
    $("alarm-lede").textContent = "Open a case from an alarm you already have. ORBIT does not detect anomalies.";
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
    ? `${alarmTitle(alarm)} crossed warn at ${clock(a.warn.time_s)} (${fmt(v, 2)} ${ch.unit || ""}).`
    : `No ${alarmTitle(alarm)} warn in this telemetry. Entry still stands — you opened from an alarm you already had.`;
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
      v: a.payloadA,
      unit: "A",
      why: a.payloadSuspect
        ? `SCIENCE_MODE draw is ${fmt(a.payloadRatio, 1)}× the ${fmt(a.payloadHealthy, 1)} A healthy baseline.`
        : a.science
          ? `SCIENCE_MODE at ${clock(a.science.time_s)} — looks guilty only if current is ≥2× ~0.9 A.`
          : "Payload never left STANDBY in this run.",
      ratio: a.payloadRatio != null ? `${fmt(a.payloadRatio, 1)}× science` : a.mode?.value_text || "",
      cls: a.payloadSuspect ? "suspect-payload" : a.science && !a.suspect ? "confounder" : "",
    },
    a.batterySuspect
      ? {
          k: "Battery",
          v: sampleAt(series("EPS.battery_voltage"), a.t)?.value_num,
          unit: "V",
          why: "Pack sagged with healthy load currents. That is IR, not a load to inhibit.",
          ratio: "EPS-09",
          cls: "suspect-battery",
        }
      : {
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
      title: `${alarmChannel()} WARN`,
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
  root.innerHTML = tracesToDraw().map(
    (t) => `<article class="trace ${t.primary ? "primary" : ""}" data-ch="${t.id}"></article>`
  ).join("");
  tracesToDraw().forEach((t) => {
    const el = root.querySelector(`[data-ch="${t.id}"]`);
    drawTrace(el, t.id, t.title, t.color, t.primary);
  });
  updateReadouts();
}

function renderProc(a) {
  const id = procedureId(a);
  const book = PROC_BOOK[id];
  $("proc-id").textContent = id;
  $("proc-title").textContent = book.title;
  $("proc-aka").textContent = book.aka;
  $("proc-applies").textContent = book.applies;
  $("proc-entry").innerHTML = book.entry;
  $("proc-goal").textContent = book.goal;
  const status = {
    confirm: a?.warn ? "Satisfied" : "",
    commands: a?.windowEvents.length ? "Satisfied" : "",
    currents: a?.heaterA != null || a?.payloadA != null ? "Satisfied" : "",
    ratio: a?.suspect || a?.payloadSuspect || a?.batterySuspect ? "Satisfied" : "",
    payload: a ? "Satisfied" : "",
    action: a?.suspect || a?.payloadSuspect || a?.batterySuspect ? "Not sent" : "",
  };
  $("proc").innerHTML = book.steps.map((step) => {
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
  const fileBtn = $("file-incident");
  const openPane = $("decide-open");
  const filedPane = $("decide-filed");
  const filed = state.incident?.status === "filed";
  openPane.hidden = filed;
  filedPane.hidden = !filed;
  fileBtn.hidden = filed || !state.incidentId;
  fileBtn.disabled = Boolean(state.filing);
  fileBtn.textContent = state.filing ? "Filing…" : "File decision";
  if (filed) {
    $("filed-action-title").textContent = $("decide-title").textContent || "Filed";
    const note = (state.incident.notes || "").trim();
    const box = $("operator-note");
    if (note && !note.startsWith("Canonical")) {
      box.hidden = false;
      box.textContent = note;
    } else {
      box.hidden = true;
    }
  }
  if (!a) {
    $("decide-title").textContent = "None yet";
    $("decide-sub").textContent = "Select a case to see a next step.";
    status.textContent = "";
    fileBtn.hidden = true;
    return;
  }
  if (a.suspect) {
    $("decide-title").textContent = "Inhibit Heater B";
    $("decide-sub").textContent = "Then watch EPS.bus_voltage recover. Leave the payload as-is unless the bus does not come back.";
    status.textContent = "Not sent";
    if (filed) {
      $("filed-action-title").textContent = "Inhibit Heater B";
      $("filed-action-sub").textContent = "Recorded in the library. ORBIT did not uplink.";
    }
    return;
  }
  if (a.payloadSuspect) {
    $("decide-title").textContent = "Safe payload to STANDBY";
    $("decide-sub").textContent = "Payload current is ≥2× healthy science. Do not inhibit Heater B.";
    status.textContent = "Not sent";
    if (filed) {
      $("filed-action-title").textContent = "Safe payload to STANDBY";
      $("filed-action-sub").textContent = "Recorded in the library. ORBIT did not uplink.";
    }
    return;
  }
  if (a.batterySuspect) {
    $("decide-title").textContent = "Continue EPS-09";
    $("decide-sub").textContent = "Pack sagged under a healthy load. Do not inhibit the heater or payload.";
    status.textContent = "Not sent";
    if (filed) {
      $("filed-action-title").textContent = "Continue EPS-09";
      $("filed-action-sub").textContent = "Recorded in the library. ORBIT did not uplink.";
    }
    return;
  }
  if (!a.warn) {
    $("decide-title").textContent = "No action";
    $("decide-sub").textContent = "No warn on this case.";
    status.textContent = "";
    if (filed) $("filed-action-title").textContent = "No action";
    return;
  }
  $("decide-title").textContent = "Keep reading";
  $("decide-sub").textContent = "No load is ≥2× healthy.";
  status.textContent = "";
  if (filed) $("filed-action-title").textContent = "Keep reading";
}

function renderFindings() {
  const body = $("findings-body");
  const btn = $("assemble");
  btn.disabled = state.investigating || !state.incidentId;
  btn.textContent = state.investigating ? "Assembling…" : "Assemble report";
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
    body.innerHTML = `<p class="empty">Select a case to begin.</p>`;
    return;
  }
    body.innerHTML = `<div class="report-cta">
      <p class="report-cta-kicker">Not stamped</p>
      <p>Assemble the tagged report when you want this evidence on the record. OBSERVED / DERIVED / DOCUMENTED / HYPOTHESIS.</p>
      <p class="hint">Rules only — no paid model.</p>
    </div>`;
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
  const input = $("library-q");
  if (input) input.value = "";
  await searchLibrary(likeThisQuery(), { grounded: true });
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
    if (data.status && state.incident) state.incident.status = data.status;
    const listed = state.incidents.find((item) => item.id === state.incidentId);
    if (listed && data.status) listed.status = data.status;
    renderIncidents();
    renderAlarm(analysis());
    renderDecision(analysis());
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
    window.alert("Pick a tape and an alarm first.");
    return;
  }
  const res = await fetch("/incidents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    window.alert(err.detail || "Could not open case");
    return;
  }
  const created = await res.json();
  state.incidents = [created, ...state.incidents.filter((item) => item.id !== created.id)];
  closeSlip();
  form.reset();
  fillCreateForm();
  await loadIncident(created.id);
}

async function fileIncident(ev) {
  if (ev) ev.preventDefault();
  if (!state.incidentId || state.filing || state.incident?.status === "filed") return;
  state.filing = true;
  const confirmBtn = $("confirm-file");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Filing…";
  try {
    const res = await fetch(`/incidents/${encodeURIComponent(state.incidentId)}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: $("file-note").value.trim() || null }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      window.alert(err.detail || "Could not file close-out");
      return;
    }
    const data = await res.json();
    const filed = data.incident;
    state.incident = filed;
    state.incidents = state.incidents.map((item) => (item.id === filed.id ? { ...item, ...filed } : item));
    closeFileSlip();
    renderIncidents();
    renderAlarm(analysis());
    renderDecision(analysis());
    await refreshDocs();
    const input = $("library-q");
    if (input) input.value = "";
    await searchLibrary(likeThisQuery(), { grounded: true });
    $("filed-banner").scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    state.filing = false;
    confirmBtn.disabled = false;
    confirmBtn.textContent = "File decision";
    renderDecision(analysis());
  }
}

async function openDoc(id) {
  const res = await fetch(`/documents/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const doc = await res.json();
  state.openDocId = doc.id;
  state.openDoc = doc;
  const kind = libraryKind(doc);
  document.body.classList.add("lib-reading");
  $("reader-kind").textContent = libraryKindLabel(doc);
  $("reader-title").textContent = doc.title;
  const close = libraryClose(doc);
  $("reader-why").textContent = close ? `${libraryUse(doc)} · ${close}` : libraryUse(doc);
  $("reader-body").innerHTML = renderMd(doc.body);
  const reader = $("library-reader");
  reader.hidden = false;
  reader.className = `lib-reader kind-${kind}`;
  setLibraryOpen(true);
  renderLibrary();
}

function closeReader() {
  $("library-reader").hidden = true;
  $("library-reader").className = "lib-reader";
  state.openDocId = null;
  state.openDoc = null;
  document.body.classList.remove("lib-reading");
  renderLibrary();
}

function tidySnippet(s) {
  return String(s || "")
    .replace(/^#+\s*/, "")
    .replace(/\*+/g, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}

function libraryKind(doc) {
  if (String(doc.path || "").startsWith("filed:")) return "filed";
  if (doc.kind === "procedure") return "procedure";
  return "history";
}

function libraryKindLabel(doc) {
  const kind = libraryKind(doc);
  if (kind === "filed") return "filed";
  if (kind === "procedure") return "procedure";
  return "similar case";
}

function libraryFamily(doc) {
  if (LIB_COPY[doc.id]?.family) return LIB_COPY[doc.id].family;
  const blob = `${doc.id || ""} ${doc.title || ""}`;
  if (/heater/i.test(blob)) return "heater";
  if (/payload/i.test(blob)) return "payload";
  if (/battery|pack/i.test(blob)) return "battery";
  return "";
}

function libraryUse(doc) {
  if (LIB_COPY[doc.id]?.use) return LIB_COPY[doc.id].use;
  if (libraryKind(doc) === "filed") return "Already stamped on this craft. The recommended command was not sent.";
  return tidySnippet(doc.snippet || doc.title || "");
}

function libraryClose(doc) {
  if (LIB_COPY[doc.id]?.close) return LIB_COPY[doc.id].close;
  if (libraryKind(doc) === "filed") return "In the library · not uplinked";
  return "";
}

function likeThisQuery() {
  const inc = state.incident;
  const a = analysis();
  const parts = [];
  if (inc?.alarm) parts.push(inc.alarm);
  if (inc?.title) parts.push(inc.title);
  if (a?.suspect) parts.push("Heater B overcurrent 3× EPS-17 INC-0187 do not close on payload");
  else if (a?.payloadSuspect) parts.push("payload power spike SCIENCE_MODE PAY-04 INC-0191 do not inhibit heater");
  else if (a?.batterySuspect) parts.push("battery internal resistance eclipse EPS-09 INC-0162 healthy heater");
  else parts.push("similar incident procedure close-out");
  return parts.join(" ");
}

function docCard(doc, { showKind = false } = {}) {
  const kind = libraryKind(doc);
  const fam = libraryFamily(doc);
  const on = doc.id === state.openDocId ? "is-on" : "";
  const close = libraryClose(doc);
  const chip = showKind
    ? `<span class="lib-card-top"><span class="kind-chip kind-${kind}">${escapeHtml(libraryKindLabel(doc))}</span></span>`
    : "";
  return `<button type="button" class="lib-card kind-${kind} ${fam ? `fam-${fam}` : ""} ${on}" data-doc="${escapeHtml(doc.id)}">
    ${chip}
    <span class="id">${escapeHtml(doc.id)}</span>
    <span class="use">${escapeHtml(libraryUse(doc))}</span>
    ${close ? `<span class="close-line">${escapeHtml(close)}</span>` : ""}
  </button>`;
}

function docRow(doc) {
  const kind = libraryKind(doc);
  const on = doc.id === state.openDocId ? "is-on" : "";
  const line = libraryClose(doc) || libraryUse(doc);
  return `<button type="button" class="lib-row kind-${kind} ${on}" data-doc="${escapeHtml(doc.id)}">
    <span class="id">${escapeHtml(doc.id)}</span>
    <span class="use">${escapeHtml(line)}</span>
  </button>`;
}

function setLibraryOpen(open) {
  state.libraryOpen = open;
  document.body.classList.toggle("lib-open", open);
  const btn = $("library-toggle");
  if (btn) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Hide library" : "Show library");
  }
}

function libraryMode() {
  if (state.libraryPinned) return "search";
  if (state.libraryHits) return "related";
  return "catalog";
}

function renderShelf(title, items, kind = "") {
  if (!items.length) return "";
  const [top, ...rest] = items;
  const more = rest.length
    ? `<div class="lib-also">${rest.map((doc) => docRow(doc)).join("")}</div>`
    : "";
  return `<section class="lib-shelf ${kind ? `kind-${kind}` : ""}">
    <p class="family-head">${escapeHtml(title)}</p>
    ${docCard(top)}
    ${more}
  </section>`;
}

function renderLibrary() {
  const reading = Boolean(state.openDocId);
  const mode = libraryMode();
  const kicker = $("library-kicker");
  if (kicker) kicker.textContent = reading && state.openDocId ? state.openDocId : "Library";
  const modes = $("library-modes");
  if (modes) modes.hidden = reading;
  $("library-mode-case")?.classList.toggle("is-on", mode === "related");
  $("library-mode-all")?.classList.toggle("is-on", mode === "catalog");
  $("library-form").hidden = reading;
  const picks = $("library-picks");
  if (picks) {
    if (reading) {
      const pool = (state.libraryHits || state.docs).filter((doc) => doc.id !== state.incidentId);
      picks.hidden = false;
      picks.innerHTML = pool
        .slice(0, 8)
        .map((doc) => {
          const kind = libraryKind(doc);
          const on = doc.id === state.openDocId ? "is-on" : "";
          return `<button type="button" class="lib-pick kind-${kind} ${on}" data-doc="${escapeHtml(doc.id)}">${escapeHtml(doc.id)}</button>`;
        })
        .join("");
    } else {
      picks.hidden = true;
      picks.innerHTML = "";
    }
  }
  const root = $("library-body");
  if (!root) return;
  root.hidden = reading;
  if (reading) return;
  if (state.librarySearching) {
    root.innerHTML = `<p class="lib-hint">Searching…</p>`;
    return;
  }
  if (state.libraryHits) {
    const hits = state.libraryHits.filter((hit) => hit.id !== state.incidentId);
    if (!hits.length) {
      root.innerHTML = `<p class="lib-hint">Nothing close. Try All, or a shorter search.</p>`;
      return;
    }
    if (mode === "search") {
      root.innerHTML = hits.map((hit) => docCard(hit, { showKind: true })).join("");
      return;
    }
    const procs = hits.filter((hit) => libraryKind(hit) === "procedure");
    const priors = hits.filter((hit) => libraryKind(hit) === "history");
    const filed = hits.filter((hit) => libraryKind(hit) === "filed");
    root.innerHTML = [
      renderShelf("Procedures", procs, "procedure"),
      renderShelf("Similar cases", priors, "history"),
      renderShelf("Filed", filed, "filed"),
    ].join("") || `<p class="lib-hint">Nothing close for this case.</p>`;
    return;
  }
  root.innerHTML = [
    renderShelf(
      "Procedures",
      state.docs.filter((doc) => libraryKind(doc) === "procedure"),
      "procedure"
    ),
    renderShelf(
      "Similar cases",
      state.docs.filter((doc) => libraryKind(doc) === "history"),
      "history"
    ),
    renderShelf(
      "Filed",
      state.docs.filter((doc) => libraryKind(doc) === "filed"),
      "filed"
    ),
  ].join("");
}

async function searchLibrary(query, opts = {}) {
  const q = (query || "").trim();
  state.libraryQuery = q;
  if (opts.grounded) state.libraryPinned = false;
  if (!q) {
    state.libraryHits = null;
    renderLibrary();
    return;
  }
  state.librarySearching = true;
  renderLibrary();
  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}&limit=8`);
    if (!res.ok) throw new Error(`search ${res.status}`);
    state.libraryHits = await res.json();
  } catch (err) {
    state.libraryHits = [];
  } finally {
    state.librarySearching = false;
    renderLibrary();
  }
}

function followThisCase() {
  const input = $("library-q");
  if (input) input.value = "";
  if (!state.incidentId) {
    browseLibrary();
    return;
  }
  searchLibrary(likeThisQuery(), { grounded: true });
}

function browseLibrary() {
  state.libraryPinned = false;
  state.libraryQuery = "";
  state.libraryHits = null;
  const input = $("library-q");
  if (input) input.value = "";
  renderLibrary();
}

let libraryTimer = 0;
function onLibraryTyped() {
  window.clearTimeout(libraryTimer);
  libraryTimer = window.setTimeout(() => {
    const q = ($("library-q")?.value || "").trim();
    if (!q) {
      followThisCase();
      return;
    }
    state.libraryPinned = true;
    searchLibrary(q);
  }, 220);
}

async function refreshDocs() {
  const res = await fetch("/documents");
  if (!res.ok) return;
  state.docs = await res.json();
  renderLibrary();
}

function bind() {
  $("incidents").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-incident]");
    if (btn) loadIncident(btn.dataset.incident);
  });
  $("library-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    window.clearTimeout(libraryTimer);
    const q = $("library-q").value.trim();
    if (!q) {
      followThisCase();
      return;
    }
    state.libraryPinned = true;
    searchLibrary(q);
  });
  $("library-q").addEventListener("input", onLibraryTyped);
  $("library-mode-case").addEventListener("click", followThisCase);
  $("library-mode-all").addEventListener("click", browseLibrary);
  $("library-toggle").addEventListener("click", () => setLibraryOpen(!state.libraryOpen));
  $("library").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-doc]");
    if (btn) openDoc(btn.dataset.doc);
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
  $("file-incident").addEventListener("click", openFileSlip);
  $("file-form").addEventListener("submit", fileIncident);
  $("cancel-file").addEventListener("click", closeFileSlip);
  $("file-slip").addEventListener("click", (ev) => {
    if (ev.target.id === "file-slip") closeFileSlip();
  });
  const openCloseout = () => {
    if (state.incidentId) openDoc(state.incidentId);
  };
  $("open-closeout").addEventListener("click", openCloseout);
  $("open-closeout-banner").addEventListener("click", openCloseout);
  $("open-proc").addEventListener("click", () => openDoc(procedureId(analysis())));
  $("reader-close").addEventListener("click", closeReader);
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!$("slip").hidden) {
      closeSlip();
      return;
    }
    if (!$("file-slip").hidden) {
      closeFileSlip();
      return;
    }
    if (state.openDocId) {
      closeReader();
      return;
    }
    if (state.libraryOpen) setLibraryOpen(false);
  });
}

async function boot() {
  bind();
  setLibraryOpen(true);
  const [runsRes, incidentRes, alarmRes, docsRes] = await Promise.all([
    fetch("/runs"),
    fetch("/incidents"),
    fetch("/entry-alarms"),
    fetch("/documents"),
  ]);
  state.runs = await runsRes.json();
  state.incidents = await incidentRes.json();
  state.alarms = await alarmRes.json();
  state.docs = docsRes.ok ? await docsRes.json() : [];
  setStoreStatus(state.runs.length > 0);
  fillCreateForm();
  renderIncidents();
  renderLibrary();
  const preferred = state.incidents.find((item) => item.id === "INC-0204") || state.incidents[0];
  if (preferred) await loadIncident(preferred.id);
}

boot().catch((err) => {
  $("alarm-title").textContent = "Store unreachable";
  $("alarm-lede").textContent = err.message;
});
