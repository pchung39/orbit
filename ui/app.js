const ALARM = "EPS.bus_voltage";
const API = "/api";
const APP_BASE = "/app";
/** Demo: every ticket can re-run investigation with a synthesis animation. */
const DEMO_MODE = true;

let investigationStepTimer = null;

function apiUrl(path) {
  if (!path.startsWith("/")) path = `/${path}`;
  return `${API}${path}`;
}

function appPath(path = "") {
  if (!path || path === "/") return APP_BASE;
  return `${APP_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}


const TRACE_CATALOG = [
  { id: "EPS.bus_voltage", title: "Bus voltage", color: "var(--ch-bus)" },
  { id: "EPS.battery_voltage", title: "Battery voltage", color: "var(--ch-batt)" },
  { id: "THM.heater_b_current", title: "Heater B current", color: "var(--ch-heater)" },
  { id: "PAY.payload_current", title: "Payload current", color: "var(--ch-payload)" },
  { id: "EPS.bus_current", title: "Bus current", color: "var(--ch-busi)" },
  { id: "EPS.solar_array_current", title: "Solar array current", color: "var(--ch-solar)" },
];

const RUN_COPY = {
  eps204: { kind: "Archive", title: "Heater + confounder", note: "Heater 3×. SCIENCE_MODE makes the payload look guilty." },
  marg001: { kind: "Archive", title: "Marginal loads", note: "Same shape as EPS-204. Heater ~1.7× — hold, do not inhibit." },
  fault1: { kind: "Archive", title: "Heater only", note: "Same heater fault. Payload stayed STANDBY." },
  pay002: { kind: "Archive", title: "Payload spike", note: "Payload 3× on SCIENCE_MODE. Do not inhibit the heater." },
  batt003: { kind: "Archive", title: "Pack IR sag", note: "Battery sagged. Heater current is healthy." },
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
  return readableChannel(alarm);
}

function alarmTitle(alarm) {
  return readableChannel(alarm);
}

function readableChannel(alarm) {
  const ch = TRACE_CATALOG.find((row) => row.id === alarm);
  if (ch) return ch.title;
  const tail = String(alarm || "").split(".").pop() || "Alarm";
  const words = tail.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function limitPhrase(ch) {
  const limit = ch?.warn_limit == null ? null : Number(ch.warn_limit);
  if (limit == null || !Number.isFinite(limit)) return "";
  return `limit ${fmt(limit, 1)}${ch.unit ? ` ${ch.unit}` : ""}`;
}

/** Case lifecycle. Every status maps to exactly one sidebar stage. */
const STAGES = [
  { id: "decide", label: "Needs decision", tone: "warn", statuses: ["open", "recommended"] },
  { id: "watching", label: "Watching", tone: "info", statuses: ["watching"] },
  { id: "verifying", label: "Verifying", tone: "signal", statuses: ["verifying"] },
  { id: "closed", label: "Closed", tone: "mute", statuses: ["filed"] },
];

function stageOf(status) {
  const st = status || "open";
  return STAGES.find((s) => s.statuses.includes(st)) || STAGES[0];
}

function statusLabel(status) {
  const st = status || "open";
  if (st === "open") return "Not investigated";
  return stageOf(st).label;
}

function incStatusChip(status) {
  const st = status || "open";
  const cls = st === "open" ? "open" : `stage-${stageOf(st).id}`;
  return `<span class="chip chip-${cls} inc-status">${escapeHtml(statusLabel(st))}</span>`;
}

function renderSideStages() {
  const all = state.incidents || [];
  for (const stage of STAGES) {
    const n = all.filter((item) => stage.statuses.includes(item.status || "open")).length;
    const badge = document.querySelector(`[data-stage-n="${stage.id}"]`);
    if (badge) badge.textContent = n ? String(n) : "";
    const btn = document.querySelector(`[data-stage="${stage.id}"]`);
    btn?.classList.toggle("is-on", state.view === "incidents" && state.incidentFilter === stage.id);
  }
}

function sourceRunId(runId, notes) {
  const id = String(runId || "");
  if (!id.startsWith("sealed_")) return id || "other";
  const rest = id.slice("sealed_".length);
  const known = Object.keys(RUN_COPY).sort((a, b) => b.length - a.length);
  for (const key of known) {
    if (rest.startsWith(`${key}_`)) return key;
  }
  const fromNotes = String(notes || "").match(/sealed from ([^\s·]+)/);
  if (fromNotes) return fromNotes[1];
  const parts = rest.split("_");
  if (parts.length >= 3) return parts.slice(0, -2).join("_") || "other";
  return parts[0] || "other";
}

function incTapeLine(runId, notes) {
  const copy = tapeCopy({ id: runId, notes });
  return `Tape · ${copy.title}`;
}

function isGenericCaseTitle(item) {
  const title = (item.title || "").trim();
  if (!title) return true;
  if (title === `${item.alarm} · ${item.run_id}`) return true;
  if (item.alarm && title.startsWith(`${item.alarm} · sealed_`)) return true;
  return false;
}

function suggestCaseTitle(alarm, runId, alarmTime, notes) {
  const alarmLabel = alarmTitle(alarm);
  const resolved = sourceRunId(runId, notes);
  const clock = (alarmTime || "").trim();
  const copy = tapeCopy({ id: resolved });
  const base = copy.title && copy.title !== resolved ? `${copy.title} · ${alarmLabel}` : alarmLabel;
  return clock ? `${base} · ${clock}` : base;
}

function caseHeadline(item) {
  if (!isGenericCaseTitle(item)) {
    return (item.title || "").trim().replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (word) => readableChannel(word));
  }
  const notesClock = String(item.notes || "").match(/@\s*(\d{2}:\d{2}:\d{2})/);
  return suggestCaseTitle(item.alarm, item.run_id, notesClock?.[1] || openedClock(item.opened_at), item.notes);
}

function tapeGroupKey(item) {
  return sourceRunId(item.run_id, item.notes) || "other";
}

function tapeGroupLabel(key) {
  if (key === "other") return "Other tapes";
  const copy = tapeCopy({ id: key });
  return copy.kind === "Archive" ? copy.title : `${copy.kind} · ${copy.title}`;
}

const TAPE_GROUP_ORDER = ["fault1", "eps204", "marg001", "pay002", "batt003", "nominal", "other"];

function statusRank(status) {
  return STAGES.indexOf(stageOf(status));
}

function openedClock(iso) {
  const m = String(iso || "").match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

function caseAction(item) {
  const runId = sourceRunId(item.run_id, item.notes);
  if (runId === "marg001") return "Hold · do not command";
  if (item.alarm === "PAY.payload_current") return "Safe payload to STANDBY";
  if (item.alarm === "EPS.battery_voltage") return "No inhibit";
  if (item.alarm === "EPS.bus_voltage") return "Inhibit Heater B";
  return "";
}

function ordinal(n) {
  const v = n % 100;
  const suf = v >= 11 && v <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
  return `${n}${suf}`;
}

function familyOf(item, all) {
  const key = item.alarm || "other";
  const family = all
    .filter((row) => (row.alarm || "other") === key)
    .sort((a, b) => String(a.opened_at || "").localeCompare(String(b.opened_at || "")));
  const idx = Math.max(1, family.findIndex((row) => row.id === item.id) + 1);
  const filed = family.filter((row) => row.status === "filed");
  const last = filed.length ? filed[filed.length - 1] : null;
  return {
    n: family.length,
    idx,
    title: alarmTitle(item.alarm),
    close: last ? caseAction(last) : "",
    lastId: last?.id || "",
  };
}

function familyLine(item, all) {
  const fam = familyOf(item, all || state.incidents);
  if (fam.n > 1) {
    return `${ordinal(fam.idx)} of ${fam.n} ${fam.title.toLowerCase()} cases${fam.close ? ` · last filed → ${fam.close}` : " · no precedent filed yet"}`;
  }
  return fam.close
    ? `Only ${fam.title.toLowerCase()} case · filed close was ${fam.close}`
    : `First ${fam.title.toLowerCase()} case · no precedent filed yet`;
}

function rowCta(item) {
  if (DEMO_MODE) return { jump: "investigation", label: "Investigate" };
  if (item.status === "filed") return { jump: "closeout", label: "Read close-out" };
  if (item.status === "recommended") return { jump: "action", label: "Decide" };
  return { jump: "investigation", label: "Investigate" };
}

function applyIncidentPatch(incidentId, patch) {
  state.incidents = state.incidents.map((item) =>
    item.id === incidentId ? { ...item, ...patch } : item
  );
  if (state.incidentId === incidentId && state.incident) {
    state.incident = { ...state.incident, ...patch };
  }
}

function rowInvestigateBtn(incidentId) {
  const disabled = state.investigating ? " disabled" : "";
  return `<button type="button" class="inc-investigate"${disabled} data-investigate="${escapeHtml(incidentId)}">Investigate</button>`;
}



function announceLive(message) {
  const el = $("investigation-live");
  if (!el) return;
  el.textContent = "";
  window.setTimeout(() => {
    el.textContent = message;
  }, 20);
}











function tapeCopy(run) {
  const id = run?.id ? String(run.id) : "";
  const resolved = id.startsWith("sealed_") ? sourceRunId(id, run.notes) : id;
  return RUN_COPY[resolved] || { kind: "Tape", title: resolved || id, note: run?.notes || "Telemetry tape" };
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


const state = {
  view: "home",
  runs: [],
  alarms: [],
  incidents: [],
  incidentId: null,
  incident: null,
  runId: null,
  workspace: null,
  desk: null,
  deskRunId: "fault1",
  incidentFilter: "all",
  incidentFamily: "all",
  incidentTape: "all",
  incidentSort: "opened_desc",
  incidentQuery: "",
  window: "focus",
  pinT: null,
  pinSource: null,
  hoverT: null,
  report: null,
  investigating: false,
  evidenceOpen: true,
  procedureOpen: false,
  filing: false,
  feedback: null,
  feedbackSaving: false,
  archiveCatalog: [],
  inspector: {
    open: false,
    runId: null,
    channel: null,
    alarm: null,
    window: "focus",
    pinClock: null,
    loading: false,
    data: null,
    savedClockStart: null,
    savedClockEnd: null,
    savedChannelValues: null,
  },
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
  const heaterMarginal = !suspect && ratio != null && ratio >= 1.3 && ratio < 2;
  const payloadMarginal = !payloadSuspect && payloadRatio != null && payloadRatio >= 1.3 && payloadRatio < 2;
  const marginal = heaterMarginal || payloadMarginal;
  const battRows = series("EPS.battery_voltage");
  const battMeta = meta("EPS.battery_voltage");
  const battWarn = firstCrossing(battRows, battMeta.warn_limit, battMeta.limit_direction);
  const batterySuspect =
    !suspect &&
    !payloadSuspect &&
    !marginal &&
    (alarm === "EPS.battery_voltage" || Boolean(battWarn));
  const withheld =
    Boolean(warn) &&
    !suspect &&
    !payloadSuspect &&
    !batterySuspect &&
    (marginal || Boolean(heaterCmd || science));
  const heaterAtCmd = heaterCmd ? sampleAt(series("THM.heater_b_current"), heaterCmd.time_s) : null;
  const heaterAAtCmd = heaterAtCmd?.value_num ?? null;
  const ratioAtCmd = heaterAAtCmd != null ? heaterAAtCmd / healthyMax : null;
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
    heaterAtCmd,
    heaterAAtCmd,
    ratioAtCmd,
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
    marginal,
    heaterMarginal,
    payloadMarginal,
    withheld,
  };
}

function domain() {
  const a = analysis();
  const rows = series(alarmChannel());
  if (!rows.length) return [0, 1];
  const t0full = rows[0].time_s;
  const t1full = rows.at(-1).time_s;
  if (state.window === "full" || !a?.t) return [t0full, t1full];
  let t0 = Math.max(t0full, a.t - 8 * 60);
  let t1 = Math.min(t1full, a.t + 8 * 60);
  const pin = state.pinT;
  if (pin != null) {
    if (pin < t0) t0 = Math.max(t0full, pin - 45);
    if (pin > t1) t1 = Math.min(t1full, pin + 45);
  }
  return [t0, t1];
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

const TAG_MEANING = {
  observed: "A command or measurement recorded in the case evidence",
  derived: "A calculation based on recorded measurements",
  documented: "A statement supported by a cited procedure or prior incident",
  hypothesis: "A proposed explanation that remains subject to review",
};

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
    const title = TAG_MEANING[cls] || "";
    return `<span class="tag tag-${cls}" title="${escapeHtml(title)}" tabindex="0">${escapeHtml(raw)}</span>`;
  });
}

function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  return stampTags(s);
}

function renderMd(src, opts = {}) {
  const lines = src.replaceAll("\r\n", "\n").split("\n");
  const out = [];
  let i = 0;
  let list = null;
  let skippedTitle = false;
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
      if (opts.skipTitle && !skippedTitle) {
        skippedTitle = true;
        i += 1;
        continue;
      }
      out.push(`<h2>${inlineMd(line.slice(2))}</h2>`);
      i += 1;
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      out.push(`<h2>${inlineMd(line.slice(3))}</h2>`);
      i += 1;
      continue;
    }
    if (line.startsWith("### ")) {
      flushList();
      out.push(`<h3>${inlineMd(line.slice(4))}</h3>`);
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







/** Map a clock string or approximate time_s to the nearest sample/event in this workspace. */




















const INC_FILTERS = [
  { id: "all", label: "All", match: () => true },
  ...STAGES.map((stage) => ({ id: stage.id, label: stage.label, match: (item) => stage.statuses.includes(item.status || "open") })),
];

const INC_CATEGORY_ORDER = ["bus", "payload", "battery", "other"];

const INC_CATEGORY_LABELS = {
  bus: "Bus voltage",
  payload: "Payload current",
  battery: "Battery voltage",
  other: "Other",
};

function incidentCategoryOf(item) {
  return incidentTone(item);
}

function incidentSearchText(item, all) {
  const copy = tapeCopy({ id: item.run_id, notes: item.notes });
  const cta = rowCta(item);
  const headline = caseHeadline(item);
  return [
    item.id,
    item.title,
    headline,
    item.alarm,
    alarmTitle(item.alarm),
    alarmShort(item.alarm),
    copy.title,
    copy.kind,
    copy.note,
    incTapeLine(item.run_id, item.notes),
    familyLine(item, all),
    statusLabel(item.status),
    caseAction(item),
    cta.label,
    item.notes,
    openedClock(item.opened_at),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}


function renderIncFilters(all, counts) {
  const root = $("inc-filters");
  if (!root) return;
  const statusOpts = INC_FILTERS.map((f) => {
    const n = counts[f.id] ?? 0;
    const selected = state.incidentFilter === f.id ? " selected" : "";
    return `<option value="${escapeHtml(f.id)}"${selected}>${escapeHtml(f.label)} (${n})</option>`;
  }).join("");

  const present = new Set(all.map(incidentCategoryOf));
  const familyOpts = [
    { id: "all", label: "All" },
    ...INC_CATEGORY_ORDER.filter((key) => present.has(key)).map((key) => ({
      id: key,
      label: INC_CATEGORY_LABELS[key],
    })),
  ];
  const family = state.incidentFamily || "all";
  const familyHtml = familyOpts
    .map((f) => {
      const selected = family === f.id ? " selected" : "";
      return `<option value="${escapeHtml(f.id)}"${selected}>${escapeHtml(f.label)}</option>`;
    })
    .join("");

  const tapeKeys = new Set(all.map(tapeGroupKey));
  const tapeOpts = [
    { id: "all", label: "All tapes" },
    ...TAPE_GROUP_ORDER.filter((key) => tapeKeys.has(key)).map((key) => ({
      id: key,
      label: tapeGroupLabel(key),
    })),
    ...[...tapeKeys]
      .filter((key) => !TAPE_GROUP_ORDER.includes(key))
      .sort()
      .map((key) => ({ id: key, label: tapeGroupLabel(key) })),
  ];
  const tape = state.incidentTape || "all";
  const tapeHtml = tapeOpts
    .map((f) => {
      const selected = tape === f.id ? " selected" : "";
      return `<option value="${escapeHtml(f.id)}"${selected}>${escapeHtml(f.label)}</option>`;
    })
    .join("");

  const sort = state.incidentSort || "opened_desc";
  const sortHtml = [
    { id: "opened_desc", label: "Newest first" },
    { id: "opened_asc", label: "Oldest first" },
    { id: "status", label: "Status" },
    { id: "title", label: "Headline" },
  ]
    .map((f) => {
      const selected = sort === f.id ? " selected" : "";
      return `<option value="${escapeHtml(f.id)}"${selected}>${escapeHtml(f.label)}</option>`;
    })
    .join("");

  root.innerHTML = `
    <label class="inc-select">
      <span class="inc-select-label">Status</span>
      <select id="inc-status" data-inc-status>${statusOpts}</select>
    </label>
    <label class="inc-select">
      <span class="inc-select-label">Alarm</span>
      <select id="inc-family" data-inc-family>${familyHtml}</select>
    </label>
    <label class="inc-select">
      <span class="inc-select-label">Tape</span>
      <select id="inc-tape" data-inc-tape>${tapeHtml}</select>
    </label>
    <label class="inc-select">
      <span class="inc-select-label">Sort</span>
      <select id="inc-sort" data-inc-sort>${sortHtml}</select>
    </label>`;
}

function filterIncidents(all) {
  const status = INC_FILTERS.find((f) => f.id === state.incidentFilter) || INC_FILTERS[0];
  const q = (state.incidentQuery || "").trim().toLowerCase();
  const family = state.incidentFamily || "all";
  const tape = state.incidentTape || "all";
  return all.filter((item) => {
    if (!status.match(item)) return false;
    if (family !== "all" && incidentCategoryOf(item) !== family) return false;
    if (tape !== "all" && tapeGroupKey(item) !== tape) return false;
    if (q && !incidentSearchText(item, all).includes(q)) return false;
    return true;
  });
}

function sortIncidents(rows) {
  const sort = state.incidentSort || "opened_desc";
  const copy = [...rows];
  if (sort === "title") {
    copy.sort((a, b) => caseHeadline(a).localeCompare(caseHeadline(b)) || String(a.id).localeCompare(String(b.id)));
    return copy;
  }
  if (sort === "status") {
    copy.sort(
      (a, b) =>
        statusRank(a.status) - statusRank(b.status) ||
        String(b.opened_at || "").localeCompare(String(a.opened_at || "")) ||
        String(a.id).localeCompare(String(b.id))
    );
    return copy;
  }
  copy.sort((a, b) => {
    const cmp = String(b.opened_at || "").localeCompare(String(a.opened_at || "")) || String(a.id).localeCompare(String(b.id));
    return sort === "opened_asc" ? -cmp : cmp;
  });
  return copy;
}

function groupIncidentsByStage(rows) {
  return STAGES.map((stage) => ({
    key: stage.id,
    label: stage.label,
    items: rows.filter((item) => stage.statuses.includes(item.status || "open")),
  })).filter((group) => group.items.length);
}

function renderSideRecent() {
  const root = $("side-recent");
  if (!root) return;
  const recent = [...state.incidents]
    .sort((a, b) => String(b.opened_at || "").localeCompare(String(a.opened_at || "")) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 6);
  root.hidden = !recent.length;
  if (!recent.length) {
    root.innerHTML = "";
    return;
  }
  const current = state.view === "case" ? state.incidentId : null;
  root.innerHTML = `<p class="side-recent-label">Recent cases</p>${recent
    .map((item) => {
      const tone = item.status === "recommended" ? "ready" : item.status === "filed" ? "filed" : "open";
      const on = item.id === current ? " is-on" : "";
      return `<button type="button" class="side-case tone-${tone}${on}" data-open-case="${escapeHtml(item.id)}" title="${escapeHtml(`${item.id} · ${statusLabel(item.status)}`)}">
        <i aria-hidden="true"></i>
        <span class="side-case-id">${escapeHtml(item.id)}</span>
        <span class="side-case-title">${escapeHtml(caseHeadline(item))}</span>
      </button>`;
    })
    .join("")}`;
}

function renderIncidents() {
  const all = [...state.incidents];
  const counts = Object.fromEntries(INC_FILTERS.map((f) => [f.id, all.filter(f.match).length]));
  const rows = sortIncidents(filterIncidents(all));

  renderSideStages();
  renderSideRecent();

  const hero = $("inc-head");
  if (hero) {
    const pill = (filter, tone, n, label) =>
      `<button type="button" class="inc-pill tone-${tone}${state.incidentFilter === filter ? " is-on" : ""}" data-inc-pill="${filter}"><i aria-hidden="true"></i><b>${n}</b> ${label}</button>`;
    hero.innerHTML = `
      <div class="inc-head-copy">
        <p class="inc-kicker"><span class="live-dot" aria-hidden="true"></span>Aurora-1 · case log</p>
        <h1 class="inc-title">Incidents</h1>
        <p class="inc-sub">Every alarm you've opened, grouped by where it is in its lifecycle.</p>
      </div>
      <div class="inc-pills">
        ${STAGES.map((stage) => pill(stage.id, stage.tone, counts[stage.id], stage.label.toLowerCase())).join("")}
      </div>`;
  }
  renderIncFilters(all, counts);

  renderIncidentList(rows, all);
}

function renderIncidentList(rows, all) {
  const list = $("inc-list");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = `<p class="inc-empty">No cases match. Try another filter or clear your search.</p>`;
    return;
  }

  const cols = `<div class="inc-cols" aria-hidden="true">
    <span>Case</span><span>Details</span><span>Status</span>
  </div>`;
  const grouped = groupIncidentsByStage(rows);
  const useFlat = grouped.length === 1;
  list.innerHTML = useFlat
    ? `${cols}${rows.map((item) => incRow(item, all)).join("")}`
    : grouped
        .map(
          (group) => `<section class="inc-group stage-${escapeHtml(group.key)}">
        <header class="inc-group-head">
          <h2 class="inc-group-title">${escapeHtml(group.label)}</h2>
          <span class="inc-group-n">${group.items.length} case${group.items.length === 1 ? "" : "s"}</span>
        </header>
        <div class="inc-group-body">${cols}${group.items.map((item) => incRow(item, all)).join("")}</div>
      </section>`
        )
        .join("");
  if (state.view === "home") renderHomeDesk();
}

function incRowMeta(item) {
  const when = openedClock(item.opened_at);
  const bits = [
    `<span class="chip chip-xs inc-alarm-chip">${escapeHtml(alarmShort(item.alarm))}</span>`,
  ];
  if (when) bits.push(`<span class="inc-opened">${when} UTC</span>`);
  return bits.join("");
}

function incRowFamilyLine(item, all) {
  const fam = familyOf(item, all || state.incidents);
  if (fam.n <= 1) return "";
  return `<span class="inc-fam">${escapeHtml(familyLine(item, all))}</span>`;
}

function incRow(item, all) {
  const st = item.status || "open";
  const cta = rowCta(item);
  const on = state.view === "case" && item.id === state.incidentId ? "is-on" : "";
  const ready = st === "recommended" ? "is-ready" : "";
  const filed = st === "filed" ? "is-filed" : "";
  const headline = caseHeadline(item);
  return `<div class="inc-row tone-${incidentTone(item)} ${on} ${ready} ${filed}" data-open-case="${item.id}" data-jump="${cta.jump}" role="button" tabindex="0">
    <span class="id">${item.id}</span>
    <span class="inc-detail">
      <strong class="inc-headline">${escapeHtml(headline)}</strong>
      <span class="inc-meta-line">${incRowMeta(item)}</span>
      ${incRowFamilyLine(item, all)}
    </span>
    <span class="inc-status-col">${incStatusChip(st)}</span>
  </div>`;
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
  if (!hidden || !root) return;
  hidden.value = value;
  root.querySelectorAll(".pick").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.value === value);
  });
  if (kind === "alarm") {
    suggestTapeForAlarm(value);
    updateBindPreview();
  } else {
    updateBindPreview();
  }
}

function defaultAlarmTime() {
  const clock = state.desk?.clock;
  if (clock && /^\d{2}:\d{2}:\d{2}$/.test(clock)) return clock;
  return "14:32:00";
}

function suggestedRunForAlarm(alarm) {
  const ch = state.alarms.find((item) => item.id === alarm);
  const preferred = ch?.bind?.run_id;
  const archives = archiveRunsOnly();
  if (preferred && archives.some((r) => r.id === preferred)) return preferred;
  if (alarm === "PAY.payload_current") {
    const pay = archives.find((r) => r.id === "pay002");
    if (pay) return pay.id;
  }
  if (alarm === "EPS.battery_voltage") {
    const batt = archives.find((r) => r.id === "batt003");
    if (batt) return batt.id;
  }
  const fault = archives.find((r) => r.id === "fault1");
  if (fault) return fault.id;
  return (archives.find((r) => r.id === "eps204") || archives[0])?.id || "";
}

function suggestTapeForAlarm(alarm) {
  const runId = suggestedRunForAlarm(alarm);
  if (runId) setPick("run", runId);
}

function syncSuggestedTitle() {
  const input = $("new-incident")?.querySelector('[name="title"]');
  if (!input || input.dataset.userEdited === "true") return;
  const alarm = $("incident-alarm-value")?.value;
  const runId = $("incident-run-value")?.value;
  const clock = ($("incident-alarm-time")?.value || "").trim();
  input.value = alarm && runId ? suggestCaseTitle(alarm, runId, clock) : "";
}

function updateBindPreview() {
  const el = $("incident-bind-preview");
  if (!el) return;
  const alarm = $("incident-alarm-value")?.value;
  const runId = $("incident-run-value")?.value;
  const clock = ($("incident-alarm-time")?.value || "").trim();
  const ch = state.alarms.find((item) => item.id === alarm);
  const suggested = ch?.bind?.run_id;
  syncSuggestedTitle();
  if (!alarm) {
    el.textContent = "Pick an alarm, then an upstream archive tape. ORBIT will fetch and seal a time window.";
    return;
  }
  const headline = runId ? suggestCaseTitle(alarm, runId, clock) : "";
  if (runId && suggested && runId === suggested) {
    el.textContent = headline
      ? `Headline: ${headline}. Will fetch+seal from archive ${runId}${ch?.bind?.label ? ` · ${ch.bind.label}` : ""}.`
      : `Will fetch+seal a window from archive ${runId}${ch?.bind?.label ? ` · ${ch.bind.label}` : ""}. Not a live downlink.`;
    return;
  }
  if (runId) {
    el.textContent = headline
      ? `Headline: ${headline}. Will fetch+seal from archive ${runId}.`
      : `Will fetch+seal a window from archive ${runId}. Suggested archive for this alarm was ${suggested || "any available"}.`;
    return;
  }
  el.textContent = "Select an upstream archive tape to fetch+seal from.";
}

function archiveRunsOnly() {
  const catalog = state.archiveCatalog || [];
  if (catalog.length) {
    return catalog
      .filter((run) => run.available !== false)
      .map((run) => ({
        id: run.id,
        notes: run.notes,
        samples: run.samples,
        clock_start: run.clock_start,
        clock_end: run.clock_end,
        kind: "archive",
      }));
  }
  return (state.runs || []).filter((run) => !String(run.id).startsWith("sealed_"));
}

const TAPE_ORDER = ["eps204", "marg001", "fault1", "pay002", "batt003", "nominal", "inc0187", "inc0191", "inc0162"];

function sortTapes(runs) {
  return [...runs].sort((a, b) => {
    const ia = TAPE_ORDER.indexOf(a.id);
    const ib = TAPE_ORDER.indexOf(b.id);
    const ra = ia === -1 ? 100 : ia;
    const rb = ib === -1 ? 100 : ib;
    return ra - rb || a.id.localeCompare(b.id);
  });
}

function fillCreateForm() {
  $("slip-id").textContent = nextIncidentPreview();
  $("incident-alarm").innerHTML = state.alarms
    .map(
      (ch) => `<button type="button" class="pick pick-alarm" data-pick="alarm" data-value="${escapeHtml(ch.id)}">
        <span class="title">${escapeHtml(readableChannel(ch.id))}</span>
        <span class="k">${escapeHtml(ch.id)}</span>
        <span class="note">Warn at ${escapeHtml(String(ch.warn_limit))} ${escapeHtml((ch.unit || "").replace(/^degC$/, "°C"))}</span>
      </button>`
    )
    .join("");
  const archives = archiveRunsOnly();
  $("incident-run").innerHTML = sortTapes(archives)
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
  const timeInput = $("incident-alarm-time");
  if (timeInput && !timeInput.value) timeInput.value = defaultAlarmTime();
  const alarm = $("incident-alarm-value").value || ALARM;
  if (state.alarms.some((ch) => ch.id === alarm)) setPick("alarm", alarm);
  else if (state.alarms[0]) setPick("alarm", state.alarms[0].id);
  else updateBindPreview();
  syncSuggestedTitle();
}

function openSlip() {
  const timeInput = $("incident-alarm-time");
  if (timeInput) timeInput.value = defaultAlarmTime();
  const titleInput = $("new-incident")?.querySelector('[name="title"]');
  if (titleInput) delete titleInput.dataset.userEdited;
  fillCreateForm();
  $("slip").hidden = false;
}

function closeSlip() {
  $("slip").hidden = true;
}






async function loadArchiveCatalog() {
  try {
    const res = await fetch(apiUrl("/archive"));
    if (!res.ok) throw new Error(`archive ${res.status}`);
    state.archiveCatalog = await res.json();
  } catch (err) {
    state.archiveCatalog = state.archiveCatalog || [];
  }
}

async function loadBootstrapLists() {
  try {
    const [runsRes, alarmRes] = await Promise.all([fetch(apiUrl("/runs")), fetch(apiUrl("/entry-alarms"))]);
    if (runsRes.ok) state.runs = await runsRes.json();
    if (alarmRes.ok) state.alarms = await alarmRes.json();
    await loadArchiveCatalog();
  } catch (err) {
    /* keep existing */
  }
}


function formatMissionSpan(start, end) {
  if (!start && !end) return "—";
  if (start && end) return `${start}–${end} UTC`;
  return `${start || end} UTC`;
}







































function defaultInspectForRun(runId) {
  if (runId === "pay002" || runId === "inc0191") {
    return { channel: "PAY.payload_current", alarm: "PAY.payload_current" };
  }
  if (runId === "batt003" || runId === "inc0162") {
    return { channel: "EPS.battery_voltage", alarm: "EPS.battery_voltage" };
  }
  return { channel: "THM.heater_b_current", alarm: "EPS.bus_voltage" };
}

function inspectSampleValue(row) {
  if (row.value_text != null && row.value_text !== "") return row.value_text;
  if (row.value_num != null) return fmt(row.value_num, 3);
  return "—";
}

function inspectUnit(data) {
  const ch = (data?.channels || []).find((row) => row.id === data?.channel);
  return ch?.unit || "";
}

function openInspector(opts = {}) {
  const runId = opts.runId || state.runId || state.deskRunId;
  if (!runId) return;
  const defaults = defaultInspectForRun(runId);
  const fromCase = state.view === "case" && state.runId === runId;
  const a = analysis();
  const pinT = opts.pinTimeS ?? state.pinT ?? a?.t ?? null;
  state.inspector = {
    open: true,
    runId,
    channel: opts.channel || (fromCase ? alarmChannel() : defaults.channel),
    alarm: opts.alarm || (fromCase ? alarmChannel() : defaults.alarm),
    window: opts.window || (fromCase ? state.window : "focus") || "focus",
    pinClock: opts.pinClock || (pinT != null ? clock(pinT) : null),
    loading: true,
    data: null,
    savedClockStart: opts.savedClockStart ?? null,
    savedClockEnd: opts.savedClockEnd ?? null,
    savedChannelValues: opts.savedChannelValues ?? null,
  };
  $("tape-inspector")?.removeAttribute("hidden");
  document.body.classList.add("inspector-open");
  loadInspector();
}

function closeInspector() {
  state.inspector.open = false;
  $("tape-inspector")?.setAttribute("hidden", "");
  document.body.classList.remove("inspector-open");
}

async function loadInspector() {
  const ins = state.inspector;
  if (!ins.open || !ins.runId || !ins.channel) return;
  ins.loading = true;
  renderInspector();
  const params = new URLSearchParams({
    channel: ins.channel,
    window: ins.window,
  });
  if (ins.alarm) params.set("alarm", ins.alarm);
  if (ins.pinClock) params.set("pin_clock", ins.pinClock);
  try {
    const res = await fetch(apiUrl(`/runs/${encodeURIComponent(ins.runId)}/inspect?${params}`));
    if (!res.ok) throw new Error(`inspect ${res.status}`);
    ins.data = await res.json();
  } catch (err) {
    ins.data = { error: err.message };
  } finally {
    ins.loading = false;
    renderInspector();
  }
}

function renderInspector() {
  const wrap = $("tape-inspector");
  if (!wrap || !state.inspector.open) return;
  const ins = state.inspector;
  const data = ins.data;
  const copy = tapeCopy({ id: ins.runId });
  $("inspector-title").textContent = `${ins.runId} · ${copy.title}`;
  $("inspector-lede").textContent =
    "Sample-by-sample rows from the ingested store. Verify clocks and magnitudes against the report.";

  const channelOpts = (data?.channels || TRACE_CATALOG.map((ch) => ({ id: ch.id, title: ch.title })))
    .map(
      (ch) =>
        `<option value="${escapeHtml(ch.id)}" ${ch.id === ins.channel ? "selected" : ""}>${escapeHtml(ch.title || ch.id)}</option>`
    )
    .join("");
  $("inspector-controls").innerHTML = `
    <label>Channel
      <select id="inspector-channel">${channelOpts}</select>
    </label>
    <div class="seg" role="group" aria-label="Inspector window">
      <button type="button" data-inspector-window="focus" class="${ins.window === "focus" ? "is-on" : ""}">Warn ± 8 min</button>
      <button type="button" data-inspector-window="full" class="${ins.window === "full" ? "is-on" : ""}">Full saved window</button>
    </div>`;

  const meta = $("inspector-meta");
  const eventsRoot = $("inspector-events");
  const samplesRoot = $("inspector-samples");
  if (ins.loading && !data) {
    meta.textContent = "Loading samples…";
    eventsRoot.innerHTML = "";
    samplesRoot.innerHTML = "";
    return;
  }
  if (data?.error) {
    meta.textContent = data.error;
    eventsRoot.innerHTML = `<p class="inspector-empty">${escapeHtml(data.error)}</p>`;
    samplesRoot.innerHTML = "";
    return;
  }

  const channelTitle =
    (data.channels || []).find((row) => row.id === data.channel)?.title || data.channel || ins.channel;
  const savedSpan =
    ins.savedClockStart || ins.savedClockEnd
      ? formatMissionSpan(ins.savedClockStart, ins.savedClockEnd)
      : String(ins.runId || "").startsWith("sealed_") && data.from_clock && data.to_clock && ins.window === "full"
        ? formatMissionSpan(data.from_clock, data.to_clock)
        : null;
  const viewingSpan = formatMissionSpan(data.from_clock, data.to_clock);
  const viewingCount = `${Number(data.sample_count || 0).toLocaleString()} samples for ${channelTitle}`;
  const parts = [];
  if (savedSpan) {
    parts.push(`<span class="inspector-window-line"><span class="k">Saved window</span> ${escapeHtml(savedSpan)}</span>`);
  }
  parts.push(
    `<span class="inspector-window-line"><span class="k">Viewing</span> ${escapeHtml(viewingSpan)} · ${escapeHtml(viewingCount)}</span>`
  );
  if (ins.savedChannelValues != null && savedSpan) {
    parts.push(
      `<span class="inspector-window-line is-muted">${Number(ins.savedChannelValues).toLocaleString()} time steps in the saved package</span>`
    );
  }
  if (data.crossing) {
    parts.push(
      `<span class="tag-cross">first warn ${escapeHtml(data.crossing.channel)} @ ${escapeHtml(data.crossing.clock)} · ${escapeHtml(String(data.crossing.value_num ?? data.crossing.value_text ?? ""))}</span>`
    );
  }
  if (data.pin) {
    parts.push(`<span class="tag-pin">pin ${escapeHtml(data.pin.clock)}</span>`);
  }
  meta.innerHTML = parts.join("");

  const events = data.events || [];
  eventsRoot.innerHTML =
    events.length > 0
      ? `<ul class="tape-inspector-events-list">${events
          .map(
            (ev) => `<li>
              <p class="t">${escapeHtml(ev.clock)}</p>
              <p class="d">${escapeHtml(ev.detail)} · ${escapeHtml(ev.event_type || "")}</p>
            </li>`
          )
          .join("")}</ul>`
      : `<p class="inspector-empty">No commands or mode changes in this window.</p>`;

  const unit = inspectUnit(data);
  const crossT = data.crossing?.time_s;
  const pinT = data.pin?.time_s;
  const rows = (data.samples || [])
    .map((row) => {
      const t = row.time_s;
      const isCross = crossT != null && Math.abs(t - crossT) < 2.6;
      const isPin = pinT != null && Math.abs(t - pinT) < 2.6;
      const cls = `${isCross ? "is-cross" : ""} ${isPin ? "is-pin" : ""}`.trim();
      const val = inspectSampleValue(row);
      const showUnit = row.value_text == null && unit && val !== "—";
      return `<div class="inspector-row ${cls}" data-inspect-t="${t}">
        <span>${escapeHtml(row.clock)}</span>
        <span class="val">${escapeHtml(val)}${showUnit ? `<span class="unit">${escapeHtml(unit)}</span>` : ""}</span>
        <span>${escapeHtml(data.channel.split(".").pop() || "")}</span>
      </div>`;
    })
    .join("");
  samplesRoot.innerHTML = rows
    ? `<div class="inspector-cols"><span>Clock</span><span>Value</span><span>Ch</span></div>${rows}`
    : `<p class="inspector-empty">No samples in this window.</p>`;

  const samplesTitle = $("inspector-samples-title");
  if (samplesTitle) {
    samplesTitle.textContent = `Samples for ${channelTitle}`;
  }

  const targetT = pinT ?? crossT;
  if (targetT != null && rows) {
    const rowEl = [...samplesRoot.querySelectorAll("[data-inspect-t]")].find(
      (el) => Math.abs(Number(el.dataset.inspectT) - targetT) < 2.6
    );
    rowEl?.scrollIntoView({ block: "center" });
  }
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle("view-home", view === "home");
  document.body.classList.toggle("view-incidents", view === "incidents");
  document.body.classList.toggle("view-case", view === "case");
  document.body.classList.toggle("view-sources", view === "sources");
  $("tab-home")?.classList.toggle("is-on", view === "home");
  $("tab-sources")?.classList.toggle("is-on", view === "sources");
  renderSideStages();
  renderSideRecent();
  const skip = $("skip");
  if (skip) {
    skip.href =
      view === "incidents"
        ? "#incidents-desk"
        : view === "case"
          ? "#stage"
          : "#home";
    skip.textContent =
      view === "incidents"
        ? "Skip to incidents"
        : view === "case"
          ? "Skip to case"
          : "Skip to overview";
  }
}

/** Avoid pushState while applying browser back/forward or boot pathname. */
let syncingFromHistory = false;

function pathForView(view, incidentId = state.incidentId) {
  if (view === "incidents") return appPath("/incidents");
  if (view === "sources") return appPath("/sources");
  if (view === "case" && incidentId) return appPath(`/incidents/${encodeURIComponent(incidentId)}`);
  return appPath();
}

function syncUrl(view, { replace = false } = {}) {
  if (syncingFromHistory) return;
  const incidentId = view === "case" ? state.incidentId : null;
  const path = pathForView(view, incidentId);
  const same = location.pathname === path || location.pathname === `${path}/`;
  const method = replace || same ? "replaceState" : "pushState";
  history[method](
    { view, incidentId },
    "",
    path
  );
}

function parsePath(pathname) {
  let path = (pathname || "/").replace(/\/+$/, "") || "/";
  if (path === APP_BASE || path === "/") {
    return { view: "home", incidentId: null };
  }
  if (path.startsWith(`${APP_BASE}/`)) {
    path = path.slice(APP_BASE.length) || "/";
  }
  const caseMatch = path.match(/^\/incidents\/([^/]+)$/);
  if (caseMatch) {
    return { view: "case", incidentId: decodeURIComponent(caseMatch[1]) };
  }
  if (path === "/incidents") return { view: "incidents", incidentId: null };
  if (path === "/sources") return { view: "sources", incidentId: null };
  return { view: "home", incidentId: null };
}

async function routeFromPath(pathname, { replace = false } = {}) {
  const { view, incidentId } = parsePath(pathname);
  syncingFromHistory = true;
  try {
    if (view === "case" && incidentId) {
      if (state.incidentId !== incidentId || state.view !== "case" || !state.workspace) {
        await openIncident(incidentId);
      } else {
        enterCase();
      }
    } else if (view === "incidents") {
      enterIncidents();
    } else if (view === "sources") {
      enterSources();
      loadSources();
    } else {
      enterHome();
    }
    const path = pathForView(state.view, state.incidentId);
    history.replaceState(
      {
        view: state.view,
        incidentId: state.view === "case" ? state.incidentId : null,
      },
      "",
      path
    );
  } finally {
    syncingFromHistory = false;
  }
}

function enterHome() {
  setView("home");
  renderHome();
  $("stage").scrollTop = 0;
  syncUrl("home");
}

function enterIncidents() {
  setView("incidents");
  renderIncidents();
  $("stage").scrollTop = 0;
  syncUrl("incidents");
}

function enterCase() {
  setView("case");
  renderIncidents();
  syncUrl("case");
}












function renderHomeStart() {
  const root = $("home-start");
  if (!root) return;
  root.hidden = true;
  root.innerHTML = "";
}

function deskQueueItems(limit = 5) {
  const all = [...state.incidents];
  all.sort((a, b) => {
    const ra = a.status === "recommended" ? 0 : a.status === "open" ? 1 : 2;
    const rb = b.status === "recommended" ? 0 : b.status === "open" ? 1 : 2;
    if (ra !== rb) return ra - rb;
    return String(a.id).localeCompare(String(b.id));
  });
  return all.slice(0, limit);
}

function homeQueueMeta(item) {
  const when = openedClock(item.opened_at);
  const bits = [
    `<span class="chip chip-xs inc-alarm-chip">${escapeHtml(alarmShort(item.alarm))}</span>`,
  ];
  if (when) bits.push(`<span class="inc-opened">${when} UTC</span>`);
  return bits.join("");
}

function renderHomeDesk() {
  const root = $("home-desk");
  if (!root) return;
  const all = state.incidents;
  const inStage = (id) => all.filter((item) => STAGES.find((s) => s.id === id).statuses.includes(item.status || "open")).length;
  const decideN = inStage("decide");
  const watchN = inStage("watching");
  const verifyN = inStage("verifying");
  const closedN = inStage("closed");
  const rows = deskQueueItems(8);
  const list = rows.length
    ? rows
        .map((item) => {
          const st = item.status || "open";
          const cta = rowCta(item);
          const filed = st === "filed" ? " is-filed" : "";
          return `<div class="home-desk-row tone-${incidentTone(item)}${filed}" role="button" tabindex="0" data-open-case="${escapeHtml(item.id)}" data-jump="${escapeHtml(cta.jump)}">
            <span class="id">${escapeHtml(item.id)}</span>
            <span class="inc-detail">
              <strong class="inc-headline">${escapeHtml(caseHeadline(item))}</strong>
              <span class="inc-meta-line">${homeQueueMeta(item)}</span>
            </span>
            <span class="inc-status-col">${incStatusChip(st)}</span>
          </div>`;
        })
        .join("")
    : `<p class="home-desk-empty">No cases yet. Open a case from an alarm you already have.</p>`;

  const stat = (filter, tone, n, label, note) => `
    <button type="button" class="home-stat tone-${tone}" data-go-incidents="${filter}">
      <span class="home-stat-label"><i aria-hidden="true"></i>${label}</span>
      <span class="home-stat-n">${n}</span>
      <span class="home-stat-note">${note}</span>
    </button>`;
  root.innerHTML = `
    <div class="home-stats">
      ${stat("decide", "open", decideN, "Needs decision", decideN ? "Investigate or decide" : "Nothing waiting")}
      ${stat("watching", "ready", watchN, "Watching", watchN ? "Held until the evidence clears a bar" : "No holds")}
      ${stat("verifying", "filed", verifyN, "Verifying", verifyN ? "Decided; ready to close" : "Nothing to verify")}
      ${stat("closed", "closed", closedN, "Closed", "Decisions on record")}
    </div>
    <div class="home-queue">
      <div class="home-desk-head">
        <div>
          <p class="home-desk-kicker">Queue</p>
          <h2 class="home-desk-title">Needs attention</h2>
        </div>
        <div class="home-desk-actions">
          <button type="button" class="text-btn home-desk-all" data-go-incidents="all">View all ${all.length} →</button>
          <button type="button" class="btn home-desk-open" data-open-slip>Open case</button>
        </div>
      </div>
      <div class="home-desk-list">${list}</div>
    </div>`;
}


function renderHome() {
  renderHomeStart();
  renderHomeDesk();
}

async function loadDesk(runId) {
  const wanted = runId || state.deskRunId || "fault1";
  const res = await fetch(apiUrl(`/desk?run_id=${encodeURIComponent(wanted)}`));
  if (!res.ok) throw new Error(`desk ${res.status}`);
  state.desk = await res.json();
  state.deskRunId = state.desk.run_id || wanted;
}

async function goHome() {
  enterHome();
  if (!state.desk) {
    try {
      await loadDesk(state.deskRunId);
    } catch (err) {
      /* craft falls back to a static orbit */
    }
  }
}

async function goIncidents() {
  enterIncidents();
}




















async function createIncident(ev) {
  ev.preventDefault();
  const form = $("new-incident");
  const alarm = form.alarm.value;
  const runId = form.run_id?.value || $("incident-run-value")?.value || null;
  const alarmTime = ($("incident-alarm-time")?.value || "").trim() || null;
  const titleInput = form.title.value.trim();
  const body = {
    alarm,
    run_id: runId,
    alarm_time: alarmTime,
    title: titleInput || suggestCaseTitle(alarm, runId, alarmTime) || null,
  };
  if (!body.alarm) {
    window.alert("Pick an alarm first.");
    return;
  }
  if (!body.run_id) {
    window.alert("Pick an archive tape first.");
    return;
  }
  const res = await fetch(apiUrl("/incidents"), {
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



function bind() {
  window.addEventListener("popstate", () => {
    routeFromPath(location.pathname).catch((err) => {
      console.warn("routeFromPath", err);
    });
  });
  $("tab-home").addEventListener("click", () => goHome());
  $("side-stages").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-stage]");
    if (!btn) return;
    state.incidentFilter = btn.dataset.stage;
    goIncidents();
  });
  $("back-incidents").addEventListener("click", () => goIncidents());
  $("go-home-brand").addEventListener("click", () => goHome());
  $("side-recent")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-open-case]");
    if (btn) openIncident(btn.dataset.openCase);
  });
  $("home").addEventListener("click", (ev) => {
    const goInc = ev.target.closest("[data-go-incidents]");
    if (goInc) {
      if (goInc.dataset.goIncidents) state.incidentFilter = goInc.dataset.goIncidents;
      goIncidents();
      return;
    }
    if (ev.target.closest("[data-open-slip]")) {
      openSlip();
      return;
    }
    const inv = ev.target.closest("[data-investigate]");
    if (inv) {
      ev.preventDefault();
      ev.stopPropagation();
      runInvestigation(inv.dataset.investigate);
      return;
    }
    const btn = ev.target.closest("[data-open-case]");
    if (btn) openIncident(btn.dataset.openCase, btn.dataset.jump);
  });
  $("incidents-desk").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-open-slip]")) {
      openSlip();
      return;
    }
    const pill = ev.target.closest("[data-inc-pill]");
    if (pill) {
      state.incidentFilter = state.incidentFilter === pill.dataset.incPill ? "all" : pill.dataset.incPill;
      renderIncidents();
      return;
    }
    const inv = ev.target.closest("[data-investigate]");
    if (inv) {
      ev.preventDefault();
      ev.stopPropagation();
      runInvestigation(inv.dataset.investigate);
      return;
    }
    const btn = ev.target.closest("[data-open-case]");
    if (btn) openIncident(btn.dataset.openCase, btn.dataset.jump);
  });
  $("incidents-desk").addEventListener("change", (ev) => {
    const status = ev.target.closest("[data-inc-status]");
    if (status) {
      state.incidentFilter = status.value;
      renderIncidents();
      return;
    }
    const family = ev.target.closest("[data-inc-family]");
    if (family) {
      state.incidentFamily = family.value;
      renderIncidents();
      return;
    }
    const tape = ev.target.closest("[data-inc-tape]");
    if (tape) {
      state.incidentTape = tape.value;
      renderIncidents();
      return;
    }
    const sort = ev.target.closest("[data-inc-sort]");
    if (sort) {
      state.incidentSort = sort.value;
      renderIncidents();
    }
  });
  $("incidents-desk").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = ev.target.closest("[data-open-case]");
    if (!row || ev.target !== row) return;
    ev.preventDefault();
    openIncident(row.dataset.openCase, row.dataset.jump);
  });
  $("inc-search-form")?.addEventListener("submit", (ev) => ev.preventDefault());
  $("inc-q")?.addEventListener("input", () => {
    state.incidentQuery = $("inc-q").value;
    const clear = $("inc-clear");
    if (clear) clear.hidden = !state.incidentQuery.trim();
    renderIncidents();
  });
  $("inc-clear")?.addEventListener("click", () => {
    state.incidentQuery = "";
    const input = $("inc-q");
    if (input) {
      input.value = "";
      input.focus();
    }
    const clear = $("inc-clear");
    if (clear) clear.hidden = true;
    renderIncidents();
  });
  $("inspector-close")?.addEventListener("click", closeInspector);
  $("tape-inspector")?.addEventListener("click", (ev) => {
    if (ev.target.id === "tape-inspector") closeInspector();
    const win = ev.target.closest("[data-inspector-window]");
    if (win) {
      state.inspector.window = win.dataset.inspectorWindow;
      loadInspector();
    }
  });
  $("tape-inspector")?.addEventListener("change", (ev) => {
    if (ev.target.id === "inspector-channel") {
      state.inspector.channel = ev.target.value;
      loadInspector();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.inspector.open) {
      ev.preventDefault();
      closeInspector();
    }
  });
  $("theme-toggle").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
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
  $("incident-alarm-time")?.addEventListener("input", updateBindPreview);
  $("new-incident")?.querySelector('[name="title"]')?.addEventListener("input", (ev) => {
    const input = ev.target;
    if ((input.value || "").trim()) input.dataset.userEdited = "true";
    else delete input.dataset.userEdited;
  });
  bindCase();
  bindSources();
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("slip").hidden) closeSlip();
  });
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem("orbit-theme", theme);
  } catch (err) {
    /* private mode — the theme just won't persist */
  }
  const btn = $("theme-toggle");
  if (btn) btn.title = theme === "light" ? "Switch to dark" : "Switch to light";
}

function initTheme() {
  let saved = null;
  try {
    saved = window.localStorage.getItem("orbit-theme");
  } catch (err) {
    saved = null;
  }
  const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
  setTheme(saved || (prefersLight ? "light" : "dark"));
}

async function boot() {
  initTheme();
  if (DEMO_MODE) document.body.classList.add("demo-mode");
  bind();
  const [runsRes, incidentRes, alarmRes] = await Promise.all([
    fetch(apiUrl("/runs")),
    fetch(apiUrl(DEMO_MODE ? "/incidents?fresh=1" : "/incidents")),
    fetch(apiUrl("/entry-alarms")),
  ]);
  state.runs = await runsRes.json();
  state.incidents = await incidentRes.json();
  state.alarms = await alarmRes.json();
  await loadArchiveCatalog();
  fillCreateForm();
  renderIncidents();
  state.deskRunId =
    state.incidents.find((item) => item.id === "INC-0205")?.run_id ||
    state.runs.find((run) => run.id === "fault1")?.id ||
    state.runs.find((run) => run.id === "eps204")?.id ||
    state.runs[0]?.id ||
    "fault1";
  await routeFromPath(location.pathname, { replace: true });
  if (state.view === "home") {
    try {
      await loadDesk(state.deskRunId);
    } catch (err) {
      /* craft keeps static orbit */
    }
  }
}

boot().catch((err) => {
  const lede = $("home-lede");
  if (lede) {
    lede.hidden = false;
    lede.textContent = err.message;
  }
});
