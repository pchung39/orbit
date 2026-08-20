const ALARM = "EPS.bus_voltage";
const TRACE_CATALOG = [
  { id: "EPS.bus_voltage", title: "Bus voltage", color: "var(--ch-bus)" },
  { id: "EPS.battery_voltage", title: "Battery voltage", color: "var(--ch-batt)" },
  { id: "THM.heater_b_current", title: "Heater B current", color: "var(--ch-heater)" },
  { id: "PAY.payload_current", title: "Payload current", color: "var(--ch-payload)" },
  { id: "EPS.bus_current", title: "Bus current", color: "var(--ch-busi)" },
  { id: "EPS.solar_array_current", title: "Solar array current", color: "var(--ch-solar)" },
];

const TAPE_ORDER = ["eps204", "marg001", "fault1", "pay002", "batt003", "nominal", "inc0187", "inc0191", "inc0162"];

const RUN_COPY = {
  eps204: { kind: "Demo", title: "Heater + confounder", note: "Heater 3×. SCIENCE_MODE makes the payload look guilty." },
  marg001: { kind: "Decoy", title: "Marginal loads", note: "Same shape as EPS-204. Heater ~1.7× — hold, do not inhibit." },
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
  if (item.run_id === "marg001") return "Hold · do not command";
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
  if (item.status === "filed") return { jump: "closeout", label: "Read close-out" };
  if (item.status === "recommended") return { jump: "walk", label: "File · not sent" };
  return { jump: "walk", label: "Walk" };
}

function workingGuess(a) {
  if (!a) return null;
  if (a.suspect) {
    return {
      suspect: `Heater B ${fmt(a.heaterA, 2)} A · ${fmt(a.ratio, 1)}× healthy`,
      last: a.science ? `SCIENCE_MODE at ${clock(a.science.time_s)}` : a.heaterCmd ? "HEATER_B_ENABLE" : "—",
      decoy: Boolean(a.science),
      recommend: "Inhibit Heater B",
      withheld: false,
    };
  }
  if (a.payloadSuspect) {
    return {
      suspect: `Payload ${fmt(a.payloadA, 2)} A · ${fmt(a.payloadRatio, 1)}× science`,
      last: a.science ? `SCIENCE_MODE at ${clock(a.science.time_s)}` : "—",
      decoy: Boolean(a.heaterCmd),
      recommend: "Safe payload to STANDBY",
      withheld: false,
    };
  }
  if (a.batterySuspect) {
    return {
      suspect: "Pack sag · load currents healthy",
      last: a.heaterCmd ? `HEATER_B_ENABLE at ${clock(a.heaterCmd.time_s)}` : "—",
      decoy: Boolean(a.heaterCmd),
      recommend: "Continue EPS-09 · no inhibit",
      withheld: false,
    };
  }
  if (a.withheld) {
    return {
      suspect: a.ratio != null
        ? `Heater B ${fmt(a.heaterA, 2)} A · ${fmt(a.ratio, 1)}× — below ≥2× bar`
        : "No load ≥2× healthy",
      last: a.science ? `SCIENCE_MODE at ${clock(a.science.time_s)}` : a.heaterCmd ? "HEATER_B_ENABLE" : "—",
      decoy: Boolean(a.science),
      recommend: "Hold · do not command",
      withheld: true,
    };
  }
  return {
    suspect: "No load ≥2× healthy",
    last: a.science ? "SCIENCE_MODE" : a.heaterCmd ? "HEATER_B_ENABLE" : "—",
    decoy: false,
    recommend: "Keep reading",
    withheld: false,
  };
}

function activeFeedbackVerdict() {
  return state.feedback?.verdict || "";
}

function feedbackFormHtml({ editable, compact, noteId = "feedback-note" }) {
  const fb = state.feedback;
  const verdict = activeFeedbackVerdict();
  const note = fb?.note || "";
  if (!editable) {
    if (!fb) return "";
    const label = verdict === "confirmed" ? "Hypothesis confirmed" : "Hypothesis rejected";
    return `<div class="guess-feedback is-readonly">
      <p class="guess-kicker">${escapeHtml(label)}</p>
      <p class="guess-fb-key">${escapeHtml(fb.hypothesis_key || "")}</p>
      ${note ? `<p class="guess-fb-note">${escapeHtml(note)}</p>` : ""}
    </div>`;
  }
  return `<div class="guess-feedback ${compact ? "is-compact" : ""}">
    <p class="guess-kicker">Hypothesis review</p>
    <div class="fb-toggle" role="group" aria-label="Confirm or reject hypothesis">
      <button type="button" class="fb-opt ${verdict === "confirmed" ? "is-on" : ""}" data-fb-verdict="confirmed">Confirmed</button>
      <button type="button" class="fb-opt ${verdict === "rejected" ? "is-on" : ""}" data-fb-verdict="rejected">Rejected</button>
    </div>
    <label class="fb-note-label">Note <span class="opt">optional</span>
      <textarea class="feedback-note" id="${noteId}" rows="2" placeholder="Why you agree or disagree…">${escapeHtml(note)}</textarea>
    </label>
    ${compact ? "" : '<p class="hint fb-hint">Saved locally for future eval runs. Does not change the recommended action or uplink anything.</p>'}
    <button type="button" class="btn btn-ghost btn-sm" data-save-feedback ${state.feedbackSaving ? "disabled" : ""}>${state.feedbackSaving ? "Saving…" : fb ? "Update feedback" : "Save feedback"}</button>
  </div>`;
}

function renderFileSlipFeedback() {
  const root = $("file-feedback");
  if (!root) return;
  const filed = state.incident?.status === "filed";
  const a = analysis();
  if (filed) {
    root.innerHTML = feedbackFormHtml({ editable: false, compact: true });
    return;
  }
  if (a?.withheld) {
    root.innerHTML = `<div class="file-fb-summary">
      <p class="pick-label">Hold</p>
      <p class="guess-fb-key">No root-cause hypothesis — threshold not met</p>
    </div>`;
    return;
  }
  if (state.feedback) {
    root.innerHTML = `<div class="file-fb-summary">
      <p class="pick-label">Hypothesis review</p>
      <p class="guess-fb-key">${escapeHtml(state.feedback.hypothesis_key)} · ${escapeHtml(state.feedback.verdict)}</p>
      ${state.feedback.note ? `<p class="guess-fb-note">${escapeHtml(state.feedback.note)}</p>` : ""}
    </div>`;
    return;
  }
  root.innerHTML = feedbackFormHtml({ editable: true, compact: true, noteId: "file-feedback-note" });
}

async function saveFeedback(scopeEl) {
  if (!state.incidentId || state.feedbackSaving || state.incident?.status === "filed") return;
  const scope = scopeEl || $("decide-feedback-root");
  const on = scope?.querySelector("[data-fb-verdict].is-on");
  if (!on) {
    window.alert("Choose confirmed or rejected first.");
    return;
  }
  const noteEl = scope.querySelector(".feedback-note");
  const note = noteEl?.value.trim() || null;
  state.feedbackSaving = true;
  renderDecision(analysis());
  renderFileSlipFeedback();
  try {
    const res = await fetch(`/incidents/${encodeURIComponent(state.incidentId)}/feedback`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict: on.dataset.fbVerdict, note }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `feedback ${res.status}`);
    }
    const data = await res.json();
    state.feedback = data.feedback;
    if (state.incident) state.incident.feedback = data.feedback;
  } catch (err) {
    window.alert(err.message || "Could not save feedback");
  } finally {
    state.feedbackSaving = false;
    renderDecision(analysis());
    renderFileSlipFeedback();
  }
}

function hypothesisContextHtml(a, g) {
  if (!g) return "";
  if (g.withheld) {
    return `<dl class="hyp-context">
      <div><dt>Status</dt><dd>${escapeHtml(g.suspect)}</dd></div>
      <div class="${g.decoy ? "is-decoy" : ""}"><dt>Last command</dt><dd>${escapeHtml(g.last)}${g.decoy ? " <em>confounder</em>" : ""}</dd></div>
      <div class="is-act"><dt>Decision</dt><dd>${escapeHtml(g.recommend)} <i>no command</i></dd></div>
    </dl>`;
  }
  return `<dl class="hyp-context">
    <div><dt>Suspect</dt><dd>${escapeHtml(g.suspect)}</dd></div>
    <div class="${g.decoy ? "is-decoy" : ""}"><dt>Last command</dt><dd>${escapeHtml(g.last)}${g.decoy ? " <em>decoy</em>" : ""}</dd></div>
    <div class="is-act"><dt>Recommend</dt><dd>${escapeHtml(g.recommend)} <i>not sent</i></dd></div>
  </dl>`;
}

function renderDecisionContext(a) {
  const hypRoot = $("decide-hypothesis");
  const fbRoot = $("decide-feedback-root");
  const inc = state.incident;
  const filed = inc?.status === "filed";
  const g = workingGuess(a);
  const showHyp = Boolean(a && g && inc && !filed && (inc.status === "recommended" || state.report));

  if (hypRoot) {
    if (showHyp) {
      hypRoot.hidden = false;
      const kicker = g.withheld ? "No root cause asserted" : "Working hypothesis";
      hypRoot.innerHTML = `<p class="decide-section-kicker">${kicker}</p>${hypothesisContextHtml(a, g)}`;
    } else {
      hypRoot.hidden = true;
      hypRoot.innerHTML = "";
    }
  }

  if (fbRoot) {
    const showFb = inc && !filed && (inc.status === "recommended" || state.report);
    if (showFb && g?.withheld) {
      fbRoot.hidden = false;
      fbRoot.innerHTML = `<div class="guess-feedback is-withheld">
        <p class="guess-kicker">Hypothesis review</p>
        <p class="hint">ORBIT did not assert a root cause — nothing to confirm or reject. File records the hold.</p>
      </div>`;
    } else if (showFb) {
      fbRoot.hidden = false;
      fbRoot.innerHTML = feedbackFormHtml({ editable: true, compact: false, noteId: "decide-feedback-note" });
    } else if (filed && (state.feedback || inc?.feedback)) {
      fbRoot.hidden = false;
      fbRoot.innerHTML = feedbackFormHtml({ editable: false, compact: false });
    } else {
      fbRoot.hidden = true;
      fbRoot.innerHTML = "";
    }
  }
}

function renderCaseRibbon(inc) {
  const ribbon = $("case-ribbon");
  if (!ribbon) return;
  if (!inc) {
    ribbon.hidden = true;
    ribbon.innerHTML = "";
    return;
  }
  const st = inc.status || "open";
  if (st === "recommended") {
    ribbon.hidden = false;
    ribbon.innerHTML = `<span class="case-ribbon-text">Report stamped — review and file in step 06.</span>
      <button type="button" class="text-btn" data-case-jump="action">Go to decision</button>`;
    return;
  }
  if (st === "open") {
    ribbon.hidden = false;
    ribbon.innerHTML = `<span class="case-ribbon-text">Walk evidence, then assemble the report before filing.</span>`;
    return;
  }
  ribbon.hidden = true;
  ribbon.innerHTML = "";
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

function renderTapeTrigger() {
  const run = state.runs.find((r) => r.id === state.deskRunId);
  const copy = run ? tapeCopy(run) : { kind: "Tape", title: state.deskRunId || "—" };
  if ($("tape-trigger-kind")) $("tape-trigger-kind").textContent = copy.kind;
  if ($("tape-trigger-title")) $("tape-trigger-title").textContent = copy.title;
  const n = state.runs.length;
  if ($("tape-trigger-count")) $("tape-trigger-count").textContent = n ? `${n} tapes` : "";
}

function tapeItem(run, query) {
  const copy = tapeCopy(run);
  const on = run.id === state.deskRunId ? "is-on" : "";
  return `<button type="button" class="tape-row ${on}" role="option" aria-selected="${on ? "true" : "false"}" data-tape="${escapeHtml(run.id)}">
    <span class="tape-row-kind">${escapeHtml(copy.kind)}</span>
    <span class="tape-row-title">${highlightTerms(copy.title, query)}</span>
    ${copy.note ? `<span class="tape-row-note">${highlightTerms(copy.note, query)}</span>` : ""}
  </button>`;
}

function tapeGroup(title, html) {
  if (!html) return "";
  return `<section class="tape-palette-group">
    <p class="family-head">${escapeHtml(title)}</p>${html}
  </section>`;
}

function renderTapePalette() {
  const list = $("tape-palette-list");
  if (!list) return;
  const q = state.tapePaletteQuery.trim().toLowerCase();
  const tapes = sortTapes(state.runs).filter((run) => {
    if (!q) return true;
    const copy = tapeCopy(run);
    return `${copy.kind} ${copy.title} ${copy.note || ""} ${run.id}`.toLowerCase().includes(q);
  });
  if (!tapes.length) {
    list.innerHTML = `<p class="lib-hint">Nothing matched “${escapeHtml(state.tapePaletteQuery.trim())}”.</p>`;
    return;
  }
  const groups = new Map();
  for (const run of tapes) {
    const kind = tapeCopy(run).kind;
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(run);
  }
  list.innerHTML = [...groups.entries()]
    .map(([kind, runs]) => tapeGroup(`${kind} · ${runs.length}`, runs.map((r) => tapeItem(r, q)).join("")))
    .join("");
}

function openTapePalette() {
  state.tapePaletteOpen = true;
  state.tapePaletteQuery = "";
  const wrap = $("tape-palette");
  const q = $("tape-palette-q");
  const trigger = $("tape-trigger");
  if (wrap) wrap.hidden = false;
  if (trigger) trigger.setAttribute("aria-expanded", "true");
  if (q) q.value = "";
  renderTapePalette();
  q?.focus();
}

function closeTapePalette() {
  state.tapePaletteOpen = false;
  const wrap = $("tape-palette");
  const trigger = $("tape-trigger");
  if (wrap) wrap.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  trigger?.focus();
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
  view: "home",
  runs: [],
  alarms: [],
  incidents: [],
  incidentId: null,
  incident: null,
  runId: null,
  workspace: null,
  desk: null,
  deskRunId: "eps204",
  tapePaletteOpen: false,
  tapePaletteQuery: "",
  incidentFilter: "all",
  incidentQuery: "",
  window: "focus",
  pinT: null,
  hoverT: null,
  report: null,
  investigating: false,
  filing: false,
  feedback: null,
  feedbackSaving: false,
  docs: [],
  libraryQuery: "",
  libraryHits: null,
  librarySearching: false,
  libraryKind: "all",
  libraryFamily: "all",
  libraryVisibleIds: [],
  openDocId: null,
  openDoc: null,
  trust: null,
  trustLoading: false,
  inspector: {
    open: false,
    runId: null,
    channel: null,
    alarm: null,
    window: "focus",
    pinClock: null,
    loading: false,
    data: null,
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
      <g class="pin-g"></g>
      <g class="hover-g"></g>
      <text x="${pad.l}" y="${H - 6}" fill="var(--mute)" font-size="10" font-family="IBM Plex Mono, ui-monospace, monospace">${clock(t0)}</text>
      <text x="${W - pad.r}" y="${H - 6}" text-anchor="end" fill="var(--mute)" font-size="10" font-family="IBM Plex Mono, ui-monospace, monospace">${clock(t1)}</text>
      <rect class="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent" pointer-events="all"/>
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
    pinTape(state.hoverT);
  });
}

function traceCard(id) {
  return $("trace-stack")?.querySelector(`[data-ch="${id}"]`);
}

function pinTape(t, { scroll = false } = {}) {
  const n = Number(t);
  if (t == null || Number.isNaN(n)) return;
  state.pinT = n;
  state.hoverT = null;
  renderTimeline(analysis());
  updateReadouts();
  if (scroll) $("traces")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateReadouts() {
  const a = analysis();
  if (state.view === "home" || state.view === "incidents") {
    const clockEl = $("focus-clock");
    if (clockEl) clockEl.textContent = state.desk?.clock || "--:--:--";
    return;
  }
  const tPin = state.pinT ?? a?.t;
  const tHover = state.hoverT;
  const t = tHover ?? tPin;
  const clockEl = $("focus-clock");
  if (clockEl) clockEl.textContent = clock(t);
  const parts = tracesToDraw().map((ch) => {
    const row = sampleAt(series(ch.id), t);
    const unit = meta(ch.id).unit || "";
    return `${ch.title} ${fmt(row?.value_num)} ${unit}`;
  });
  const hoverRead = $("hover-read");
  if (hoverRead) hoverRead.textContent = t != null ? `${clock(t)}  ·  ${parts.join("   ")}` : "";
  tracesToDraw().forEach((spec) => {
    const el = traceCard(spec.id);
    const c = charts[spec.id];
    if (!el || !c) return;
    const now = sampleAt(c.rows, t);
    const nowEl = el.querySelector(".now");
    if (nowEl) nowEl.textContent = now ? `${fmt(now.value_num)} ${c.unit}` : "—";
    const pinG = el.querySelector(".pin-g");
    if (pinG) {
      pinG.innerHTML =
        tPin == null
          ? ""
          : `<line x1="${c.x(tPin)}" x2="${c.x(tPin)}" y1="${c.pad.t}" y2="${c.H - c.pad.b}" stroke="var(--signal)" stroke-width="1.5"/>`;
    }
    const hoverG = el.querySelector(".hover-g");
    if (!hoverG) return;
    if (tHover == null) {
      hoverG.innerHTML = "";
      return;
    }
    const sample = sampleAt(c.rows, tHover);
    const xx = c.x(tHover);
    const cy = sample ? c.y(sample.value_num) : c.pad.t;
    hoverG.innerHTML = `<line x1="${xx}" x2="${xx}" y1="${c.pad.t}" y2="${c.H - c.pad.b}" stroke="var(--ink)" stroke-width="1" opacity="0.4"/>${
      sample ? `<circle cx="${xx}" cy="${cy}" r="3.2" fill="${c.color}"/>` : ""
    }`;
  });
}

const INC_FILTERS = [
  { id: "all", label: "All", match: () => true },
  { id: "open", label: "Open", match: (item) => item.status !== "filed" && item.status !== "recommended" },
  { id: "ready", label: "Ready", match: (item) => item.status === "recommended" },
  { id: "filed", label: "Filed", match: (item) => item.status === "filed" },
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
  const copy = tapeCopy({ id: item.run_id });
  const cta = rowCta(item);
  return [
    item.id,
    item.title,
    item.alarm,
    alarmTitle(item.alarm),
    alarmShort(item.alarm),
    copy.title,
    copy.kind,
    familyLine(item, all),
    statusLabel(item.status),
    caseAction(item),
    cta.label,
    item.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function filterIncidents(all) {
  const status = INC_FILTERS.find((f) => f.id === state.incidentFilter) || INC_FILTERS[0];
  const q = (state.incidentQuery || "").trim().toLowerCase();
  return all.filter((item) => {
    if (!status.match(item)) return false;
    if (q && !incidentSearchText(item, all).includes(q)) return false;
    return true;
  });
}

function groupIncidentsByCategory(rows) {
  const groups = new Map();
  for (const item of rows) {
    const key = incidentCategoryOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return INC_CATEGORY_ORDER.filter((key) => groups.has(key)).map((key) => ({
    key,
    label: INC_CATEGORY_LABELS[key],
    items: groups.get(key),
  }));
}

function renderIncidents() {
  const byTime = (a, b) =>
    statusRank(a.status) - statusRank(b.status) || String(b.opened_at || "").localeCompare(String(a.opened_at || ""));
  const all = [...state.incidents].sort(byTime);
  const count = (id) => all.filter(INC_FILTERS.find((f) => f.id === id).match).length;
  const nOpen = count("open");
  const nReady = count("ready");
  const nFiled = count("filed");
  const rows = filterIncidents(all);

  const tabN = $("tab-incidents-n");
  if (tabN) tabN.textContent = nOpen + nReady ? String(nOpen + nReady) : "";

  const hero = $("inc-head");
  if (hero) {
    hero.innerHTML = `<div>
      <p class="craft-kicker">Aurora-1 · case log</p>
      <h1>Incidents</h1>
      <p class="inc-lede">Walk a case you already opened, or open one from an alarm you already have. ORBIT does not detect anomalies and does not uplink commands.</p>
      <div class="inc-stats">
        ${[
          { id: "open", n: nOpen, label: "Open" },
          { id: "ready", n: nReady, label: "Ready to file" },
          { id: "filed", n: nFiled, label: "Filed" },
        ]
          .map(
            (s) =>
              `<button type="button" class="inc-stat tone-${s.id} ${state.incidentFilter === s.id ? "is-on" : ""}" data-filter="${s.id}">
                <span class="n">${s.n}</span><span class="l">${s.label}</span>
              </button>`
          )
          .join("")}
      </div>
    </div>
    <button type="button" class="btn" data-open-slip>Open case</button>`;
  }

  const meta = $("inc-meta");
  if (meta) {
    const q = (state.incidentQuery || "").trim();
    const statusNote =
      state.incidentFilter !== "all"
        ? INC_FILTERS.find((f) => f.id === state.incidentFilter)?.label || ""
        : "";
    meta.textContent = `${rows.length} case${rows.length === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}${statusNote ? ` · ${statusNote}` : ""}`;
  }

  renderIncReady(all);
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
    <span>Case</span><span>Signature</span><span>Next</span>
  </div>`;
  list.innerHTML = groupIncidentsByCategory(rows)
    .map(
      (group) => `<section class="inc-group tone-${group.key}">
        <header class="inc-group-head">
          <h2 class="inc-group-title">${escapeHtml(group.label)}</h2>
          <span class="inc-group-n">${group.items.length} case${group.items.length === 1 ? "" : "s"}</span>
        </header>
        <div class="inc-group-body">${cols}${group.items.map((item) => incRow(item, all)).join("")}</div>
      </section>`
    )
    .join("");
}

/* Ready-to-file queue — inline band above the categorized list. */
function renderIncReady(all) {
  const root = $("inc-ready");
  if (!root) return;
  const ready = all.filter((item) => item.status === "recommended");
  if (!ready.length) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  root.innerHTML = `
    <p class="inc-ready-label">${ready.length} ready to file</p>
    ${ready
      .map(
        (item) => `<button type="button" class="inc-ready-item" data-open-case="${escapeHtml(item.id)}">
          <span class="id">${escapeHtml(item.id)}</span>
          <span class="act">${escapeHtml(caseAction(item) || "Review report")}</span>
          <span class="why">${escapeHtml(alarmTitle(item.alarm))}</span>
        </button>`
      )
      .join("")}`;
}

function incRow(item, all) {
  const st = item.status || "open";
  const copy = tapeCopy({ id: item.run_id });
  const cta = rowCta(item);
  const on = state.view === "case" && item.id === state.incidentId ? "is-on" : "";
  return `<div class="inc-row tone-${incidentTone(item)} ${on} ${st === "recommended" ? "is-ready" : ""}" data-open-case="${item.id}" data-jump="${cta.jump}" role="button" tabindex="0">
    <span class="id">${item.id}</span>
    <span class="inc-alarm">
      <strong>${escapeHtml(alarmTitle(item.alarm))}</strong>
      <span class="inc-fam">${escapeHtml(familyLine(item, all))}</span>
      <span class="inc-tape">${escapeHtml(copy.kind)} · ${escapeHtml(copy.title)}</span>
    </span>
    <span class="inc-cta">${escapeHtml(cta.label)}</span>
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
  renderFileSlipFeedback();
  $("file-slip").hidden = false;
  $("file-note").focus();
}

function closeFileSlip() {
  $("file-slip").hidden = true;
}

function setStoreStatus(ok, detail) {
  const el = $("store-status");
  if (!el) return;
  el.classList.toggle("is-on", ok);
  el.classList.toggle("is-empty", !ok);
  const st = el.querySelector(".st");
  if (st) st.textContent = detail || (ok ? "STORE OK" : "NO STORE");
}

function trustTone(ok, warn) {
  if (ok) return "ok";
  if (warn) return "warn";
  return "bad";
}

function trustStatusLabel(tone) {
  if (tone === "ok") return "Ready";
  if (tone === "warn") return "Partial";
  return "Offline";
}

async function loadTrust() {
  state.trustLoading = true;
  renderTrust();
  try {
    const res = await fetch("/trust");
    if (!res.ok) throw new Error(`trust ${res.status}`);
    state.trust = await res.json();
    setStoreStatus(state.trust.store?.linked, state.trust.store?.linked ? "STORE OK" : "NO STORE");
  } catch (err) {
    state.trust = null;
    setStoreStatus(false, "NO STORE");
    if ($("trust-head")) {
      $("trust-head").innerHTML = `<h1>Trust</h1><p class="trust-head-lede">${escapeHtml(err.message)}</p>`;
    }
  } finally {
    state.trustLoading = false;
    renderTrust();
  }
}

function renderTrust() {
  const t = state.trust;
  const head = $("trust-head");
  const boundary = $("trust-boundary");
  const grid = $("trust-grid");
  const tapes = $("trust-tapes");
  const sources = $("trust-sources");
  const foot = $("trust-foot");
  if (!head || !boundary || !grid || !tapes || !sources || !foot) return;

  if (state.trustLoading && !t) {
    head.innerHTML = `<h1>Trust</h1><p class="trust-head-lede">Checking data sources…</p>`;
    grid.innerHTML = "";
    tapes.innerHTML = `<p class="trust-empty">Loading…</p>`;
    sources.innerHTML = "";
    foot.textContent = "";
    return;
  }
  if (!t) {
    head.innerHTML = `<h1>Trust</h1><p class="trust-head-lede">Could not load store status. Is Postgres running?</p>`;
    boundary.innerHTML = "";
    grid.innerHTML = "";
    tapes.innerHTML = `<p class="trust-empty">Run <code>docker compose up -d</code> and <code>python -m storage ingest</code>, then refresh.</p>`;
    sources.innerHTML = "";
    foot.textContent = "";
    return;
  }

  const storeTone = trustTone(t.store?.linked);
  const libraryTone = trustTone(t.library?.ready, t.library?.documents > 0 && !t.library?.ready);
  const investigatorTone = "ok";

  const openN = t.incidents?.by_status?.open || 0;
  const readyN = t.incidents?.by_status?.recommended || 0;
  const filedN = t.incidents?.by_status?.filed || 0;

  head.innerHTML = `
    <h1>Can I trust this console?</h1>
    <p class="trust-head-lede">Where ORBIT's numbers come from, what is ingested, and what the product will never do on its own.</p>
    <div class="trust-summary">
      <span class="trust-pill is-${storeTone}"><span class="dot"></span>Telemetry store</span>
      <span class="trust-pill is-${libraryTone}"><span class="dot"></span>Library index</span>
      <span class="trust-pill is-ok"><span class="dot"></span>Rules investigator</span>
      <span class="trust-pill is-${storeTone}"><span class="dot"></span>${escapeHtml(t.mission || "Aurora-1")}</span>
    </div>`;

  boundary.innerHTML = `
    <h2>Product boundaries</h2>
    <ul>${(t.boundaries || [])
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join("")}</ul>`;

  const sc = t.eval?.scorecard;
  const scoreTone = sc ? (sc.ok ? "ok" : "bad") : "warn";
  const scoreStatus = sc
    ? `${sc.cases_ok}/${sc.cases_total} cases`
    : `${t.eval?.cases ?? 5} cases`;
  const scoreRates = sc
    ? [sc.diagnosis, sc.withhold, sc.false_inhibit, sc.provenance].filter(Boolean)
    : [];
  const scoreBody = sc
    ? `<p class="trust-score-headline">${escapeHtml(sc.headline || "")}</p>
      <div class="trust-metrics trust-score-metrics">
        ${scoreRates
          .map(
            (r) => `<div class="trust-metric" title="${escapeHtml(r.definition || "")}">
          <span class="k">${escapeHtml(r.label)}</span>
          <span class="v">${escapeHtml(r.display || `${r.passed}/${r.total}`)}</span>
        </div>`
          )
          .join("")}
      </div>
      <p class="trust-note">Last run <code>${escapeHtml(sc.provider || "rules")}</code> · ${escapeHtml(
        sc.generated_at || "—"
      )}. Refresh with <code>${escapeHtml(t.eval?.command || "python -m eval")}</code>.</p>`
    : `<div class="trust-metrics">
        <div class="trust-metric"><span class="k">Harness cases</span><span class="v">${t.eval?.cases ?? 5}</span></div>
        <div class="trust-metric"><span class="k">Fault families</span><span class="v">${t.spec?.fault_families ?? 3}</span></div>
        <div class="trust-metric"><span class="k">Default</span><span class="v">${escapeHtml(t.eval?.provider_default || "rules")}</span></div>
      </div>
      <p class="trust-note">No scorecard yet. Run <code>${escapeHtml(
        t.eval?.command || "python -m eval"
      )}</code> to write diagnosis, false-inhibit, and provenance rates.</p>`;

  grid.innerHTML = `
    <article class="trust-card is-${storeTone}">
      <div class="trust-card-head">
        <div>
          <p class="trust-card-kicker">Data plane</p>
          <h3>Telemetry store</h3>
        </div>
        <span class="trust-status ${storeTone}">${trustStatusLabel(storeTone)}</span>
      </div>
      <div class="trust-metrics">
        <div class="trust-metric"><span class="k">Tapes ingested</span><span class="v">${t.store?.runs ?? 0}</span></div>
        <div class="trust-metric"><span class="k">Samples</span><span class="v">${(t.store?.telemetry_samples ?? 0).toLocaleString()}</span></div>
        <div class="trust-metric"><span class="k">Channels in spec</span><span class="v">${t.store?.channels_in_spec ?? 0}</span></div>
        <div class="trust-metric"><span class="k">Warn channels</span><span class="v">${t.store?.warn_channels ?? 0}</span></div>
      </div>
      <p class="trust-note">Postgres replay of simulator CSVs. Overview and case tape views read the last sample on the selected run — not a live downlink.</p>
      <div class="trust-card-actions">
        <button type="button" class="btn-ghost btn" data-trust-overview>Overview</button>
      </div>
    </article>
    <article class="trust-card is-${libraryTone}">
      <div class="trust-card-head">
        <div>
          <p class="trust-card-kicker">Knowledge plane</p>
          <h3>Library index</h3>
        </div>
        <span class="trust-status ${libraryTone}">${trustStatusLabel(libraryTone)}</span>
      </div>
      <div class="trust-metrics">
        <div class="trust-metric"><span class="k">Documents</span><span class="v">${t.library?.documents ?? 0}</span></div>
        <div class="trust-metric"><span class="k">Embedded</span><span class="v">${t.library?.embedded ?? 0}</span></div>
        <div class="trust-metric"><span class="k">Model</span><span class="v" style="font-size:11px">${escapeHtml(t.library?.embedding_model || "local")}</span></div>
        <div class="trust-metric"><span class="k">Dims</span><span class="v">${t.library?.embedding_dims ?? "—"}</span></div>
      </div>
      <p class="trust-note">Semantic search during investigation uses local embeddings — not a paid API. Rebuild with <code>python -m storage ingest</code>.</p>
      <div class="trust-card-actions">
        <button type="button" class="btn-ghost btn" data-trust-library>Open library</button>
      </div>
    </article>
    <article class="trust-card is-${investigatorTone}">
      <div class="trust-card-head">
        <div>
          <p class="trust-card-kicker">Investigation</p>
          <h3>Report assembly</h3>
        </div>
        <span class="trust-status ok">Rules</span>
      </div>
      <div class="trust-metrics">
        <div class="trust-metric"><span class="k">UI provider</span><span class="v">${escapeHtml(t.investigator?.provider_ui || "rules")}</span></div>
        <div class="trust-metric"><span class="k">CLI providers</span><span class="v" style="font-size:11px">rules · LLM</span></div>
        <div class="trust-metric"><span class="k">Open cases</span><span class="v">${openN}</span></div>
        <div class="trust-metric"><span class="k">Ready / filed</span><span class="v">${readyN} / ${filedN}</span></div>
      </div>
      <p class="trust-note">Assemble report writes tagged markdown from rules over the store. Paid models stay on the CLI unless you opt in there.</p>
      <div class="trust-card-actions">
        <button type="button" class="btn-ghost btn" data-trust-incidents>Open incidents</button>
      </div>
    </article>
    <article class="trust-card is-${scoreTone}">
      <div class="trust-card-head">
        <div>
          <p class="trust-card-kicker">Validation</p>
          <h3>Eval scorecard</h3>
        </div>
        <span class="trust-status ${scoreTone}">${escapeHtml(scoreStatus)}</span>
      </div>
      ${scoreBody}
    </article>`;

  const runRows = (t.runs || []).map((run) => {
    const copy = tapeCopy(run);
    const on = run.id === state.deskRunId ? "is-on" : "";
    const span =
      run.clock_start && run.clock_end ? `${run.clock_start} → ${run.clock_end}` : "—";
    return `<div class="trust-row ${on}">
      <span class="id">${escapeHtml(run.id)}</span>
      <div>
        <strong>${escapeHtml(copy.title)}</strong>
        <p class="meta">${escapeHtml(copy.note || run.notes || "")}</p>
      </div>
      <span class="kind">${escapeHtml(copy.kind)}</span>
      <span class="n">${span}</span>
      <span class="n">${(run.samples || 0).toLocaleString()}</span>
      <span class="act trust-row-actions"><button type="button" class="text-btn" data-trust-inspect="${escapeHtml(run.id)}">Inspect</button><button type="button" class="text-btn" data-trust-tape="${escapeHtml(run.id)}">${run.id === state.deskRunId ? "Selected" : "View"}</button></span>
    </div>`;
  });
  tapes.innerHTML =
    runRows.length > 0
      ? `<div class="trust-cols"><span>Run</span><span>Title</span><span>Kind</span><span>Span</span><span>Samples</span><span></span></div>${runRows.join("")}`
      : `<p class="trust-empty">No tapes ingested yet.</p>`;

  const docRows = (t.documents || []).map((doc) => {
    const kindCls = doc.kind === "procedure" ? "kind-procedure" : "kind-incident";
    return `<div class="trust-source">
      <span class="id ${kindCls}">${escapeHtml(doc.id)}</span>
      <div>
        <strong>${escapeHtml(doc.title || doc.id)}</strong>
        <p class="path">${escapeHtml(doc.path || "")}</p>
      </div>
      <button type="button" class="text-btn" data-trust-doc="${escapeHtml(doc.id)}">Open</button>
    </div>`;
  });
  sources.innerHTML =
    docRows.length > 0
      ? docRows.join("")
      : `<p class="trust-empty">No library documents embedded. Run ingest to index procedures and priors.</p>`;

  foot.textContent = `Spec: ${t.spec?.fault_families ?? 0} fault families · ${t.store?.events ?? 0} scripted events in store · Health endpoint /health`;
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
    const res = await fetch(`/runs/${encodeURIComponent(ins.runId)}/inspect?${params}`);
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
      <button type="button" data-inspector-window="full" class="${ins.window === "full" ? "is-on" : ""}">Full run</button>
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
    eventsRoot.innerHTML = `<p class="trust-empty">${escapeHtml(data.error)}</p>`;
    samplesRoot.innerHTML = "";
    return;
  }

  const parts = [
    `${data.from_clock} → ${data.to_clock}`,
    `${data.sample_count} samples`,
  ];
  if (data.crossing) {
    parts.push(
      `<span class="tag-cross">first warn ${escapeHtml(data.crossing.channel)} @ ${escapeHtml(data.crossing.clock)} · ${escapeHtml(String(data.crossing.value_num ?? data.crossing.value_text ?? ""))}</span>`
    );
  }
  if (data.pin) {
    parts.push(`<span class="tag-pin">pin ${escapeHtml(data.pin.clock)}</span>`);
  }
  meta.innerHTML = parts.join(" · ");

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
      : `<p class="trust-empty">No commands or mode changes in this window.</p>`;

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
    : `<p class="trust-empty">No samples in this window.</p>`;

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
  document.body.classList.toggle("view-library", view === "library");
  document.body.classList.toggle("view-trust", view === "trust");
  $("tab-home")?.classList.toggle("is-on", view === "home");
  $("tab-incidents")?.classList.toggle("is-on", view === "incidents");
  $("tab-library")?.classList.toggle("is-on", view === "library");
  $("tab-trust")?.classList.toggle("is-on", view === "trust");
  const skip = $("skip");
  if (skip) {
    skip.href =
      view === "incidents"
        ? "#incidents-desk"
        : view === "case"
          ? "#stage"
          : view === "library"
            ? "#library-desk"
            : view === "trust"
              ? "#trust-desk"
              : "#home";
    skip.textContent =
      view === "incidents"
        ? "Skip to incidents"
        : view === "case"
          ? "Skip to case"
          : view === "library"
            ? "Skip to library"
            : view === "trust"
              ? "Skip to trust"
              : "Skip to overview";
  }
}

function enterHome() {
  setView("home");
  renderDesk();
  updateReadouts();
  $("stage").scrollTop = 0;
}

function enterIncidents() {
  setView("incidents");
  renderIncidents();
  updateReadouts();
  $("stage").scrollTop = 0;
}

function enterCase() {
  setView("case");
  renderIncidents();
  setSpine("compare");
}

function enterLibrary() {
  setView("library");
  renderLibrary();
  $("stage").scrollTop = 0;
}

function enterTrust() {
  setView("trust");
  loadTrust();
  $("stage").scrollTop = 0;
}

async function goTrust() {
  enterTrust();
}

/* Case spine: the six steps of the walk, kept in sync with the scroll position. */
const SPINE_IDS = ["compare", "commands", "traces", "procedure", "findings", "action"];
const spineVisible = new Map();

function setSpine(id) {
  document.querySelectorAll(".spine-step").forEach((btn) => {
    btn.classList.toggle("is-on", btn.dataset.target === id);
  });
}

function initSpine() {
  const root = $("stage");
  const spine = $("case-spine");
  if (!root || !spine) return;
  spine.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-target]");
    if (btn) $(btn.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  if (typeof IntersectionObserver !== "function") return;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) spineVisible.set(entry.target.id, entry.isIntersecting);
      if (state.view !== "case") return;
      const first = SPINE_IDS.find((id) => spineVisible.get(id));
      if (first) setSpine(first);
    },
    { root, rootMargin: "-10% 0px -68% 0px", threshold: 0 }
  );
  for (const id of SPINE_IDS) {
    const el = $(id);
    if (el) observer.observe(el);
  }
}

function channelInk(id) {
  if (id.includes("heater")) return "var(--ch-heater)";
  if (id.includes("PAY") || id.includes("payload")) return "var(--ch-payload)";
  if (id.includes("solar")) return "var(--ch-solar)";
  if (id.includes("battery")) return "var(--ch-batt)";
  if (id.includes("bus_current")) return "var(--ch-busi)";
  return "var(--ch-bus)";
}

function sparkGeom(ch) {
  const W = 260;
  const H = 44;
  const padT = 4;
  const padB = 4;
  const isMode = ch.id === "PAY.mode";
  const vals = (ch.spark || []).map((p) =>
    isMode ? (p.value_text === "SCIENCE_MODE" ? 1 : 0) : p.value_num
  );
  const nums = vals.filter((v) => v != null);
  if (nums.length < 2) return null;
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (!isMode && ch.warn_limit != null) {
    lo = Math.min(lo, Number(ch.warn_limit));
    hi = Math.max(hi, Number(ch.warn_limit));
  }
  if (hi === lo) {
    lo -= 0.5;
    hi += 0.5;
  }
  const span = hi - lo;
  lo -= span * 0.12;
  hi += span * 0.12;
  return {
    W,
    H,
    vals,
    isMode,
    x: (i) => (i / Math.max(1, ch.spark.length - 1)) * W,
    y: (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB),
  };
}

function sparkSvg(ch) {
  const g = sparkGeom(ch);
  if (!g) return "";
  const parts = [];
  (ch.spark || []).forEach((p, i) => {
    const v = g.vals[i];
    if (v == null) return;
    if (!parts.length) {
      parts.push(`M${g.x(i).toFixed(1)} ${g.y(v).toFixed(1)}`);
      return;
    }
    if (g.isMode) {
      parts.push(`H${g.x(i).toFixed(1)}`);
      parts.push(`V${g.y(v).toFixed(1)}`);
    } else {
      parts.push(`L${g.x(i).toFixed(1)} ${g.y(v).toFixed(1)}`);
    }
  });
  const warn =
    !g.isMode && ch.warn_limit != null
      ? `<line x1="0" x2="${g.W}" y1="${g.y(Number(ch.warn_limit)).toFixed(1)}" y2="${g.y(Number(ch.warn_limit)).toFixed(1)}" stroke="var(--warn)" stroke-dasharray="3 3" stroke-width="1" opacity="0.7"/>`
      : "";
  return `<svg class="ch-spark" viewBox="0 0 ${g.W} ${g.H}" preserveAspectRatio="none" aria-hidden="true">
    ${warn}
    <path d="${parts.join(" ")}" fill="none" stroke="${channelInk(ch.id)}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <g class="spark-dot"></g>
    <rect class="spark-hit" x="0" y="0" width="${g.W}" height="${g.H}" fill="transparent"/>
  </svg>`;
}

function orbitSvg(orbit) {
  if (!orbit) return "";
  const theta = Number(orbit.phase || 0) * Math.PI * 2;
  const cx = 158;
  const cy = 70;
  const rx = 112;
  const ry = 40;
  const x = (cx + rx * Math.cos(theta)).toFixed(1);
  const y = (cy + ry * Math.sin(theta)).toFixed(1);
  const sun = orbit.illumination === "sun";
  const mark = sun ? "#7ff0d4" : "#f2a33c";
  /* Sun sits at the orbit focus; teal arc is the sunlit half; craft dot colour = current illumination. */
  return `<svg class="orbit-map" viewBox="0 0 320 148" aria-hidden="true">
    <defs>
      <radialGradient id="orbit-sun">
        <stop offset="0%" stop-color="#ffe08a" stop-opacity="0.85" />
        <stop offset="55%" stop-color="#ffe08a" stop-opacity="0.22" />
        <stop offset="100%" stop-color="#ffe08a" stop-opacity="0" />
      </radialGradient>
      <radialGradient id="orbit-earth" cx="34%" cy="30%">
        <stop offset="0%" stop-color="#2d4a63" />
        <stop offset="100%" stop-color="#0b141d" />
      </radialGradient>
    </defs>
    <circle cx="${cx}" cy="${cy}" r="46" fill="url(#orbit-sun)" />
    <circle cx="${cx}" cy="${cy}" r="8" fill="#ffe08a" opacity="0.95" />
    <g transform="rotate(-20 ${cx} ${cy})">
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#22323f" stroke-width="1.2" />
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="rgba(127,240,212,0.45)"
        stroke-width="1.6" stroke-dasharray="252 253" stroke-dashoffset="126" />
      <circle cx="${x}" cy="${y}" r="9" fill="none" stroke="${mark}" stroke-width="1" opacity="0.35" />
      <circle cx="${x}" cy="${y}" r="4" fill="${mark}" />
    </g>
    <circle cx="${cx}" cy="${cy}" r="16" fill="url(#orbit-earth)" stroke="#22323f" stroke-width="1" />
    <text x="14" y="136" fill="#66798c" font-size="9" font-family="IBM Plex Mono,monospace" letter-spacing="1.8">ECLIPSE</text>
    <text x="306" y="136" text-anchor="end" fill="#66798c" font-size="9" font-family="IBM Plex Mono,monospace" letter-spacing="1.8">SUNLIT</text>
  </svg>`;
}

function tileValue(ch, sample) {
  const row = sample || ch;
  if (ch.id === "PAY.mode") return row.value_text || "—";
  return row.value_num != null ? fmt(row.value_num, 2) : "—";
}

function tileLimit(ch, sample) {
  const row = sample || ch;
  if (ch.id === "PAY.mode") return row.clock ? `${row.clock} on tape` : "On this tape";
  if (ch.crossed) {
    return `Warn ${ch.crossed.clock} · limit ${ch.warn_limit} ${ch.unit || ""}`.trim();
  }
  if (ch.warn_limit != null) return `Limit ${ch.warn_limit} ${ch.unit || ""}`.trim();
  return row.clock ? `${row.clock} on tape` : "No warn on this channel";
}

/* How far this reading sits from its warn limit, so the operator doesn't do the
   arithmetic. The meter's tick sits at the limit; fill past it means outside. */
function marginMeter(ch) {
  if (ch.id === "PAY.mode") return "";
  const value = ch.value_num;
  const warn = ch.warn_limit == null ? null : Number(ch.warn_limit);
  if (value == null || warn == null || !Number.isFinite(warn) || warn === 0) return "";
  const below = ch.limit_direction === "below";
  const ratio = value / warn;
  const past = below ? warn - value : value - warn;
  const pct = Math.abs(past / warn) * 100;
  const outside = past > 0;
  const label = outside
    ? `${pct.toFixed(pct < 10 ? 1 : 0)}% past warn`
    : `${pct.toFixed(pct < 10 ? 1 : 0)}% margin`;
  /* The tick sits at 62% of the track; scale so the limit always lands on it. */
  const fill = below
    ? Math.min(100, (1 / Math.max(ratio, 1e-6)) * 62)
    : Math.min(100, ratio * 62);
  return `<p class="ch-margin">
    <span class="ch-meter"><i style="width:${fill.toFixed(0)}%"></i></span>
    <span class="pct">${label}</span>
  </p>`;
}

function sitrep() {
  const chans = state.desk?.channels || [];
  const orbit = state.desk?.orbit;
  const warns = chans.filter((ch) => ch.id !== "PAY.mode" && (ch.state === "warn" || ch.state === "critical"));
  const crits = warns.filter((ch) => ch.state === "critical");
  const mode = chans.find((ch) => ch.id === "PAY.mode");
  const illum = orbit?.illumination === "sun" ? "Sunlit" : orbit ? "Eclipse" : "Tape";
  const worst = crits[0] || warns[0];
  const level = crits.length ? "crit" : warns.length ? "warn" : "ok";
  const label = crits.length ? "Critical" : warns.length ? "Warn" : "Nominal";
  const headline = worst
    ? `${worst.title} ${tileValue(worst)} ${worst.unit || ""}`.replace(/\s+/g, " ").trim()
    : "All channels inside limits";
  const others = warns.length - 1;
  const title = worst
    ? `${worst.title} ${worst.state === "critical" ? "critical" : "at warn"}${others > 0 ? ` · ${others} more outside limits` : ""}`
    : "All channels inside limits";
  const lines = [];
  for (const ch of warns) {
    const at = ch.crossed?.clock ? ` at ${ch.crossed.clock}` : "";
    lines.push(`${ch.title} is ${tileValue(ch)} ${ch.unit || ""}${at}.`.replace(/\s+/g, " ").trim());
  }
  if (mode?.value_text) lines.push(`Payload is ${String(mode.value_text).replaceAll("_", " ")}.`);
  if (!warns.length) {
    lines.push("Last sample on this tape is inside limits. Open a case only if you already have an alarm.");
  }
  return { level, label, headline, title, lede: lines.join(" "), illum, warn: warns.length > 0 };
}

function renderDesk() {
  const desk = state.desk;
  const orbit = desk?.orbit;
  if ($("home-clock")) $("home-clock").textContent = desk?.clock || "--:--:--";
  if ($("home-illum")) {
    $("home-illum").textContent = orbit?.illumination === "sun" ? "Sunlit" : orbit ? "Eclipse" : "";
  }
  if ($("home-orbit-meta")) {
    $("home-orbit-meta").textContent = orbit ? `${orbit.period_min} min orbit` : "";
  }
  if ($("home-orbit")) $("home-orbit").innerHTML = orbitSvg(orbit);
  if ($("focus-clock") && (state.view === "home" || state.view === "incidents" || state.view === "library")) {
    $("focus-clock").textContent = desk?.clock || "--:--:--";
  }

  renderTapeTrigger();

  const channels = $("home-channels");
  if (channels) {
    channels.innerHTML = (desk?.channels || [])
      .map((ch) => {
        const tone = ch.state === "critical" ? "is-crit" : ch.state === "warn" ? "is-warn" : "";
        const isMode = ch.id === "PAY.mode";
        const science = isMode && ch.value_text === "SCIENCE_MODE" ? "is-science" : "";
        const unit = isMode ? "" : ch.unit || "";
        const badge = ch.state === "critical" ? "Crit" : ch.state === "warn" ? "Warn" : "Nominal";
        return `<article class="ch-tile ${tone} ${science} ${isMode ? "is-mode" : ""}" data-ch="${escapeHtml(ch.id)}">
          <p class="ch-kicker"><span>${escapeHtml(ch.subsystem || "")}</span><span class="st">${badge}</span></p>
          <h3>${escapeHtml(ch.title)}</h3>
          <p class="ch-read"><span class="ch-value">${escapeHtml(tileValue(ch))}</span><span class="ch-unit">${escapeHtml(unit)}</span></p>
          ${marginMeter(ch)}
          <p class="ch-limit">${escapeHtml(tileLimit(ch))}</p>
          ${sparkSvg(ch)}
        </article>`;
      })
      .join("");
    bindDeskSparks();
  }

  const sit = sitrep();
  const posture = $("home-posture");
  if (posture) {
    posture.className = `posture is-${sit.level}`;
    posture.innerHTML = `<span class="dot"></span>
      <span class="k">${escapeHtml(sit.label)}</span>
      <span class="v">${escapeHtml(sit.headline)}</span>`;
  }
}

function bindDeskSparks() {
  const root = $("home-channels");
  if (!root) return;
  root.querySelectorAll("[data-ch]").forEach((el) => {
    const id = el.dataset.ch;
    const ch = (state.desk?.channels || []).find((row) => row.id === id);
    const hit = el.querySelector(".spark-hit");
    if (!ch || !hit) return;
    const g = sparkGeom(ch);
    const show = (sample) => {
      const value = el.querySelector(".ch-value");
      const limit = el.querySelector(".ch-limit");
      const dot = el.querySelector(".spark-dot");
      if (value) value.textContent = tileValue(ch, sample);
      if (limit && sample) limit.textContent = `${sample.clock} on tape`;
      if (state.view === "home" && sample?.clock) $("focus-clock").textContent = sample.clock;
      if (dot && g && sample) {
        const i = (ch.spark || []).indexOf(sample);
        const v = g.vals[i];
        if (i >= 0 && v != null) {
          dot.innerHTML = `<circle cx="${g.x(i).toFixed(1)}" cy="${g.y(v).toFixed(1)}" r="3.2" fill="${channelInk(ch.id)}"/>`;
        }
      }
    };
    hit.addEventListener("mousemove", (ev) => {
      const rect = hit.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      const i = Math.round(frac * Math.max(0, (ch.spark || []).length - 1));
      show(ch.spark[i]);
    });
    hit.addEventListener("mouseleave", () => {
      show(ch);
      const dot = el.querySelector(".spark-dot");
      if (dot) dot.innerHTML = "";
      if (state.view === "home") $("focus-clock").textContent = state.desk?.clock || "--:--:--";
      const limit = el.querySelector(".ch-limit");
      if (limit) limit.textContent = tileLimit(ch);
    });
  });
}

async function loadDesk(runId) {
  const wanted = runId || state.deskRunId || "eps204";
  const res = await fetch(`/desk?run_id=${encodeURIComponent(wanted)}`);
  if (!res.ok) throw new Error(`desk ${res.status}`);
  state.desk = await res.json();
  state.deskRunId = state.desk.run_id || wanted;
  if (state.view === "home") renderDesk();
}

async function goHome() {
  enterHome();
  if (!state.desk) await loadDesk(state.deskRunId);
}

async function goIncidents() {
  enterIncidents();
}

function goLibrary() {
  enterLibrary();
}

function renderAlarm(a) {
  const hero = $("alarm");
  const inc = state.incident;
  const alarm = alarmChannel();
  const st = inc?.status || "";
  $("alarm-kicker").textContent = inc ? inc.id : "Case";
  const chip = $("status-chip");
  if (chip) {
    if (inc && st) {
      chip.hidden = false;
      chip.textContent = statusLabel(st);
      chip.className = `chip chip-${st === "recommended" ? "ready" : st}`;
    } else {
      chip.hidden = true;
      chip.textContent = "";
      chip.className = "chip";
    }
  }
  document.body.classList.toggle("is-filed", st === "filed");
  const filedLine = $("case-filed");
  if (filedLine) filedLine.hidden = st !== "filed";
  $("alarm-title").textContent = inc ? alarmTitle(inc.alarm) : "Select a case";
  renderCaseRibbon(inc);
  const when = a?.warn ? clock(a.warn.time_s) : openedClock(inc?.opened_at);
  const facts = [];
  if (inc) {
    if (a?.warn) facts.push({ k: "First warn", v: when, tone: "warn" });
    else if (when) facts.push({ k: "Opened", v: when });
    facts.push({ k: "Entry", v: alarm });
    if (inc.run_id) facts.push({ k: "Tape", v: tapeCopy({ id: inc.run_id }).title, sub: inc.run_id });
  }
  $("case-meta").innerHTML = facts
    .map(
      (f) => `<div class="fact ${f.tone ? `is-${f.tone}` : ""}">
        <dt>${escapeHtml(f.k)}</dt>
        <dd>${escapeHtml(f.v)}${f.sub ? `<span class="sub">${escapeHtml(f.sub)}</span>` : ""}</dd>
      </div>`
    )
    .join("");
  if (!a) {
    $("alarm-lede").textContent = "Open a case from an alarm you already have. ORBIT does not detect anomalies.";
    $("alarm-lede").hidden = false;
    $("hero-readout").hidden = true;
    hero.classList.remove("is-warn", "is-ok");
    return;
  }
  const v = a.warn?.value_num ?? sampleAt(series(alarm), a.t)?.value_num;
  const ch = meta(alarm);
  const crossed = Boolean(a.warn);
  const unit = ch.unit || "";
  $("alarm-lede").hidden = true;
  $("alarm-lede").textContent = "";
  $("hero-readout").hidden = false;
  $("alarm-ch").textContent = alarm;
  $("alarm-value").textContent = fmt(v, 2);
  $("alarm-unit").textContent = unit;
  renderAlarmMargin(v, ch);
  $("alarm-limit").innerHTML = `${
    crossed ? `<span class="flag">Warn ${escapeHtml(clock(a.warn.time_s))}</span>` : ""
  }<span class="lim">limit ${fmt(ch.warn_limit, 1)} ${escapeHtml(unit)}</span>`;
  hero.classList.toggle("is-warn", crossed);
  hero.classList.toggle("is-ok", !crossed);
}

/* Same 62% tick as the overview meters: the limit always lands in the same place,
   so the bar reads as distance from the limit rather than an absolute value. */
function renderAlarmMargin(value, ch) {
  const el = $("alarm-meter");
  if (!el) return;
  const limit = ch.warn_limit == null ? null : Number(ch.warn_limit);
  if (value == null || limit == null || !Number.isFinite(limit) || limit === 0) {
    el.hidden = true;
    return;
  }
  const below = ch.limit_direction === "below";
  const ratio = value / limit;
  const fill = Math.min(100, (below ? 1 / Math.max(ratio, 1e-6) : ratio) * 62);
  const past = below ? limit - value : value - limit;
  const pct = Math.abs(past / limit) * 100;
  el.hidden = false;
  el.querySelector("i").style.width = `${fill.toFixed(0)}%`;
  el.querySelector(".pct").textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}% ${past > 0 ? "past warn" : "margin"}`;
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
      why: a.heaterMarginal
        ? `Elevated (~${fmt(a.ratio, 1)}×) but below EPS-17 prime-suspect bar (≥2×).`
        : `Healthy ON is ${fmt(meta("THM.heater_b_current").nominal_range?.[0], 1)}–${fmt(a.healthyMax, 1)} A.`,
      ratio: a.ratio != null ? `${fmt(a.ratio, 1)}× healthy max` : "",
      cls: a.suspect ? "suspect" : a.heaterMarginal ? "marginal" : "",
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
  const lastCmd = a.windowEvents.reduce((best, e) => (!best || e.time_s >= best.time_s ? e : best), null);
  // SUSPECT only when ratio clears ≥2× — not on enable/mode event name alone.
  const suspectDetail = a.suspect ? "HEATER_B_ENABLE" : a.payloadSuspect ? "SCIENCE_MODE" : "";
  const items = a.windowEvents.map((e) => {
    const mode = e.detail === "SCIENCE_MODE" || e.event_type === "mode_change";
    return {
      t: e.time_s,
      title: e.detail,
      sub: `${e.event_type} · ${e.channel || ""}`.trim(),
      kind: mode ? "mode" : "command",
      suspect: Boolean(suspectDetail && e.detail === suspectDetail),
      last: lastCmd && e.detail === lastCmd.detail && Math.abs(e.time_s - lastCmd.time_s) < 1,
      warn: false,
      marginal: a.heaterMarginal && e.detail === "HEATER_B_ENABLE",
    };
  });
  if (a.warn) {
    items.push({
      t: a.warn.time_s,
      title: `${alarmChannel()} WARN`,
      sub: `${fmt(a.warn.value_num, 2)} ${meta(alarmChannel()).unit || ""} · first crossing`,
      kind: "warn",
      suspect: false,
      last: false,
      warn: true,
      marginal: false,
    });
  }
  items.sort((x, y) => x.t - y.t);
  const pin = state.pinT;
  root.innerHTML = items
    .map((item) => {
      const on = pin != null && Math.abs(pin - item.t) < 3;
      const tags = [
        item.suspect ? `<span class="crumb-tag is-suspect">Suspect</span>` : "",
        item.marginal && !item.suspect ? `<span class="crumb-tag is-marginal">Elevated</span>` : "",
        item.last && !item.suspect ? `<span class="crumb-tag is-last">Last</span>` : "",
        item.warn ? `<span class="crumb-tag is-warn">Warn</span>` : "",
      ].join("");
      return `<li class="tl-item kind-${item.kind} ${item.warn ? "is-warn" : ""} ${item.suspect ? "is-suspect" : ""} ${item.marginal && !item.suspect ? "is-marginal" : ""} ${item.last && !item.suspect ? "is-last" : ""} ${on ? "is-on" : ""}" data-t="${item.t}">
        <button type="button" class="tl-row ${on ? "is-on" : ""}">
          <span class="tl-time">${clock(item.t)}</span>
          <span class="tl-track" aria-hidden="true"><i class="tl-dot"></i></span>
          <span class="tl-main">
            <strong class="tl-title">${escapeHtml(item.title)}</strong>
            ${tags ? `<span class="tl-tags">${tags}</span>` : ""}
          </span>
        </button>
      </li>`;
    })
    .join("") || `<li><p class="empty">No commands in the window.</p></li>`;
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
  const named = Boolean(a?.suspect || a?.payloadSuspect || a?.batterySuspect);
  const status = {
    confirm: a?.warn ? "Satisfied" : "",
    commands: a?.windowEvents.length ? "Satisfied" : "",
    currents: a?.heaterA != null || a?.payloadA != null ? "Satisfied" : "",
    ratio: named ? "Satisfied" : a?.withheld ? "Below bar" : "",
    payload: a ? "Satisfied" : "",
    action: named ? "Not sent" : a?.withheld ? "Blocked" : "",
  };
  $("proc").innerHTML = book.steps.map((step) => {
    const label = status[step.id];
    const done = label === "Satisfied";
    const blocked = label === "Blocked" || label === "Below bar";
    const human = step.human && Boolean(label) && !blocked;
    return `<li class="${done ? "is-done" : ""} ${human ? "is-action" : ""} ${blocked ? "is-blocked" : ""}">
      <span class="proc-n">${step.n}</span>
      <span class="proc-text">${escapeHtml(step.label)}${blocked && step.human ? " <em>Threshold not met — do not command yet</em>" : ""}</span>
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
    const note = (state.incident.notes || "").trim();
    const box = $("operator-note");
    if (note && !note.startsWith("Canonical")) {
      box.hidden = false;
      box.textContent = note;
    } else {
      box.hidden = true;
    }
    const badge = $("filed-feedback-badge");
    const fb = state.feedback || state.incident?.feedback;
    if (badge) {
      if (fb?.verdict) {
        badge.hidden = false;
        badge.textContent =
          fb.verdict === "confirmed"
            ? `Hypothesis confirmed · ${fb.hypothesis_key}`
            : `Hypothesis rejected · ${fb.hypothesis_key}`;
      } else {
        badge.hidden = true;
        badge.textContent = "";
      }
    }
  }
  if (!a) {
    $("decide-title").textContent = "None yet";
    $("decide-sub").textContent = "Select a case to see a next step.";
    status.textContent = "";
    fileBtn.hidden = true;
    renderDecisionContext(null);
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
    renderDecisionContext(a);
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
    renderDecisionContext(a);
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
    renderDecisionContext(a);
    return;
  }
  if (!a.warn) {
    $("decide-title").textContent = "No action";
    $("decide-sub").textContent = "No warn on this case.";
    status.textContent = "";
    if (filed) $("filed-action-title").textContent = "No action";
    renderDecisionContext(a);
    return;
  }
  if (a.withheld) {
    $("decide-title").textContent = "Hold — do not command";
    $("decide-sub").textContent =
      "EPS-17 step 4 not met. Do not inhibit or safe until a load crosses ≥2× or ops authorizes a diagnostic.";
    status.textContent = "No command";
    if (filed) {
      $("filed-action-title").textContent = "Hold — do not command";
      $("filed-action-sub").textContent = "Threshold not met. Recorded in the library. ORBIT did not uplink.";
    }
    renderDecisionContext(a);
    return;
  }
  $("decide-title").textContent = "Keep reading";
  $("decide-sub").textContent = "No load is ≥2× healthy.";
  status.textContent = "";
  if (filed) $("filed-action-title").textContent = "Keep reading";
  renderDecisionContext(a);
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
        return !/^tool log$/i.test(title) && !/^hypothesis$/i.test(title) && !/recommended human decision/i.test(title);
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
      <p>Assemble the tagged report when you want this evidence on the record. Every claim gets its provenance:</p>
      <p class="report-legend">
        <span class="tag tag-observed">OBSERVED</span>
        <span class="tag tag-derived">DERIVED</span>
        <span class="tag tag-documented">DOCUMENTED</span>
        <span class="tag tag-hypothesis">HYPOTHESIS</span>
      </p>
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

async function openIncident(incidentId, jump) {
  await loadIncident(incidentId);
  if (jump === "closeout") {
    openDoc(incidentId);
  } else if (jump === "findings") {
    $("findings")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function loadIncident(incidentId) {
  state.incidentId = incidentId;
  state.incident = state.incidents.find((item) => item.id === incidentId) || null;
  state.feedback = state.incident?.feedback || null;
  state.runId = state.incident?.run_id || null;
  state.report = null;
  state.pinT = null;
  state.hoverT = null;
  enterCase();
  $("stage").scrollTop = 0;
  renderIncidents();
  const res = await fetch(`/incidents/${encodeURIComponent(incidentId)}/workspace`);
  if (!res.ok) throw new Error(`workspace ${res.status}`);
  state.workspace = await res.json();
  if (state.workspace.incident) {
    state.incident = state.workspace.incident;
    state.feedback = state.incident.feedback || state.feedback;
  }
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
    $("alarm").scrollIntoView({ behavior: "smooth", block: "start" });
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
  const close = libraryClose(doc);
  $("reader-kind").textContent = libraryKindLabel(doc);
  $("reader-title").textContent = doc.title;
  $("reader-why").textContent = close ? `${libraryUse(doc)} · ${close}` : libraryUse(doc);
  $("reader-body").innerHTML = renderMd(doc.body, { skipTitle: true });
  const actions = $("reader-actions");
  const listed = state.incidents.find((item) => item.id === doc.id);
  if (actions) {
    actions.innerHTML = listed
      ? `<button type="button" class="btn-bar" data-open-listed="${escapeHtml(doc.id)}">Open case</button>`
      : "";
  }
  const reader = $("library-reader");
  if (reader) reader.className = `lib-page kind-${kind}`;
  enterLibrary();
  reader?.scrollTo?.(0, 0);
}

function closeReader() {
  state.openDocId = null;
  state.openDoc = null;
  const reader = $("library-reader");
  if (reader) reader.className = "lib-page";
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

function libraryFamily(doc) {
  if (LIB_COPY[doc.id]?.family) return LIB_COPY[doc.id].family;
  const inc = state.incidents.find((item) => item.id === doc.id);
  if (inc?.alarm === "PAY.payload_current") return "payload";
  if (inc?.alarm === "EPS.battery_voltage") return "battery";
  if (inc?.alarm === "EPS.bus_voltage") return "heater";
  if (doc.id === "EPS-09") return "battery";
  if (String(doc.id).startsWith("PAY")) return "payload";
  if (String(doc.id).startsWith("EPS")) return "heater";
  return "other";
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

const LIB_KINDS = [
  { id: "all", label: "All" },
  { id: "procedure", label: "Procedures" },
  { id: "history", label: "Cases" },
  { id: "filed", label: "Filed" },
];

const LIB_FAMILIES = [
  { id: "all", label: "All signatures" },
  { id: "heater", label: "Heater" },
  { id: "payload", label: "Payload" },
  { id: "battery", label: "Pack" },
];

const LIB_SUGGEST = [
  { q: "heater 3× overcurrent EPS-17", label: "Heater 3×" },
  { q: "SCIENCE_MODE payload current", label: "Science mode" },
  { q: "battery internal resistance eclipse", label: "Pack IR" },
  { q: "EPS-17 low voltage load", label: "EPS-17" },
];

const KIND_RANK = { procedure: 0, history: 1, filed: 2 };

function escapeRx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightTerms(text, query) {
  const safe = escapeHtml(text);
  const terms = String(query || "")
    .split(/[^\w.-]+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return safe;
  const rx = new RegExp(`(${terms.map(escapeRx).join("|")})`, "gi");
  return safe.replace(rx, "<mark>$1</mark>");
}

/* The documents this case is actually built on, chosen by the same analysis that
   drives the case — not by search ranking. Each one states why it is here. */
function groundedDocs() {
  if (!state.incidentId) return [];
  const a = analysis();
  const byId = (id) => state.docs.find((doc) => doc.id === id);
  const out = [];
  const proc = byId(procedureId(a));
  if (proc) out.push({ doc: proc, why: "Procedure for this case" });
  const priorId = a?.suspect ? "INC-0187" : a?.payloadSuspect ? "INC-0191" : a?.batterySuspect ? "INC-0162" : null;
  const prior = priorId ? byId(priorId) : null;
  if (prior) out.push({ doc: prior, why: "Same signature" });
  const own = state.docs.find(
    (doc) => doc.id === state.incidentId && String(doc.path || "").startsWith("filed:")
  );
  if (own) out.push({ doc: own, why: "This case, filed" });
  return out;
}

function matchScaler(hits) {
  const scores = hits.map((h) => Number(h.score) || 0);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const span = max - min;
  return (hit) => (span > 1e-4 ? 18 + 82 * ((Number(hit.score) - min) / span) : 100);
}

function libItem(doc, opts = {}) {
  const kind = libraryKind(doc);
  const on = doc.id === state.openDocId ? "is-on" : "";
  const close = libraryClose(doc);
  const q = opts.query || "";
  const match =
    opts.match != null
      ? `<span class="lib-match">
          <span class="bar"><i style="width:${opts.match.toFixed(0)}%"></i></span>
          <span class="score">${Number(doc.score || 0).toFixed(2)}</span>
        </span>`
      : "";
  return `<button type="button" class="lib-item kind-${kind} ${on}" data-doc="${escapeHtml(doc.id)}">
    <span class="lib-item-top">
      <span class="id">${highlightTerms(doc.id, q)}</span>
      <span class="kind-chip kind-${kind}">${escapeHtml(libraryKindLabel(doc))}</span>
    </span>
    <span class="use">${highlightTerms(libraryUse(doc), q)}</span>
    ${close ? `<span class="close-line">${escapeHtml(close)}</span>` : ""}
    ${opts.why ? `<span class="lib-why">${escapeHtml(opts.why)}</span>` : ""}
    ${match}
  </button>`;
}

function libGroup(title, html, extra = "") {
  if (!html) return "";
  return `<section class="lib-group ${extra}">
    <p class="family-head">${escapeHtml(title)}</p>${html}
  </section>`;
}

function renderLibrary() {
  const kicker = $("library-kicker");
  if (kicker) kicker.textContent = state.openDocId ? `${state.openDocId} · book` : "Aurora-1 · book";
  const kindsRoot = $("library-kinds");
  const famRoot = $("library-families");
  const status = $("library-status");
  const root = $("library-body");
  const count = $("library-count");
  const clear = $("library-clear");
  const suggest = $("library-suggest");
  if (clear) clear.hidden = !state.libraryQuery;
  if (count) count.textContent = `${state.docs.length} docs`;

  const query = state.libraryQuery;
  const kind = state.libraryKind || "all";
  const family = state.libraryFamily || "all";
  const inKind = (doc) => kind === "all" || libraryKind(doc) === kind;
  const inFam = (doc) => family === "all" || libraryFamily(doc) === family;
  const visible = (doc) => inKind(doc) && inFam(doc);

  const base = query && state.libraryHits ? state.libraryHits : state.docs;
  const kindCounts = { all: 0, procedure: 0, history: 0, filed: 0 };
  const famCounts = { all: 0, heater: 0, payload: 0, battery: 0 };
  for (const doc of base) {
    if (!inFam(doc)) continue;
    kindCounts.all += 1;
    kindCounts[libraryKind(doc)] = (kindCounts[libraryKind(doc)] || 0) + 1;
  }
  for (const doc of base) {
    if (!inKind(doc)) continue;
    famCounts.all += 1;
    const fam = libraryFamily(doc);
    if (famCounts[fam] != null) famCounts[fam] += 1;
  }
  if (kindsRoot) {
    kindsRoot.innerHTML = LIB_KINDS.map(
      (k) =>
        `<button type="button" class="lib-kind kind-${k.id} ${k.id === kind ? "is-on" : ""}" data-kind="${k.id}">${k.label}<span class="n">${kindCounts[k.id] || 0}</span></button>`
    ).join("");
  }
  if (famRoot) {
    famRoot.innerHTML = LIB_FAMILIES.map(
      (f) =>
        `<button type="button" class="lib-fam fam-${f.id} ${f.id === family ? "is-on" : ""}" data-family="${f.id}">${f.label}<span class="n">${famCounts[f.id] || 0}</span></button>`
    ).join("");
  }
  if (suggest) {
    const chips = LIB_SUGGEST.map(
      (s) =>
        `<button type="button" class="lib-chip ${query === s.q ? "is-on" : ""}" data-suggest="${escapeHtml(s.q)}">${escapeHtml(s.label)}</button>`
    );
    if (state.incidentId) {
      chips.unshift(
        `<button type="button" class="lib-chip ${!query ? "is-on" : ""}" data-for-case="1">For ${escapeHtml(state.incidentId)}</button>`
      );
    }
    suggest.innerHTML = chips.join("");
  }

  const shelf = $("library-shelf");
  const article = $("library-article");
  const reader = $("library-reader");
  const reading = Boolean(state.openDocId && state.openDoc);
  if (shelf) shelf.hidden = reading;
  if (article) article.hidden = !reading;
  if (reader && !reading) reader.className = "lib-page";
  $("library-desk")?.classList.toggle("is-reading", reading);
  if (suggest) suggest.hidden = reading;

  if (!root) return;
  state.libraryVisibleIds = [];

  const remember = (docs) => {
    for (const doc of docs) {
      if (!state.libraryVisibleIds.includes(doc.id)) state.libraryVisibleIds.push(doc.id);
    }
  };

  if (state.librarySearching) {
    if (status) status.textContent = "Searching";
    root.innerHTML = `<p class="lib-hint">Searching the library…</p>`;
    if (shelf && !reading) shelf.innerHTML = `<p class="lib-hint">Searching the library…</p>`;
    return;
  }

  if (query) {
    const hits = (state.libraryHits || []).filter(visible);
    remember(hits);
    if (status) status.textContent = `${hits.length} result${hits.length === 1 ? "" : "s"} · “${query}”`;
    if (!hits.length) {
      root.innerHTML = `<p class="lib-hint">Nothing matched “${escapeHtml(query)}”. Try a shorter search, or clear a filter.</p>`;
      if (shelf && !reading) {
        shelf.innerHTML = `<p class="eyebrow">Search</p><h2>Nothing matched</h2><p class="lib-shelf-lede">“${escapeHtml(query)}” is not in this filter. Try a shorter phrase, or clear kind / signature.</p>`;
      }
      return;
    }
    const scale = matchScaler(hits);
    root.innerHTML = hits.map((hit) => libItem(hit, { query, match: scale(hit) })).join("");
    if (shelf && !reading) renderLibraryShelf(hits, { query, scale, searching: true });
    root.querySelector(".lib-item.is-on")?.scrollIntoView({ block: "nearest" });
    return;
  }

  const ground = groundedDocs().filter((g) => visible(g.doc));
  const groundIds = new Set(ground.map((g) => g.doc.id));
  const related = (state.libraryHits || []).filter((doc) => visible(doc) && !groundIds.has(doc.id));
  const relatedIds = new Set(related.map((doc) => doc.id));
  const rest = state.docs
    .filter((doc) => visible(doc) && !groundIds.has(doc.id) && !relatedIds.has(doc.id))
    .sort(
      (a, b) =>
        (KIND_RANK[libraryKind(a)] ?? 9) - (KIND_RANK[libraryKind(b)] ?? 9) || String(a.id).localeCompare(String(b.id))
    );
    remember(ground.map((g) => g.doc));
    remember(related);
    remember(rest);

    const shown = ground.length + related.length + rest.length;
  if (status) {
    status.textContent = state.incidentId
      ? `${shown} document${shown === 1 ? "" : "s"} · ranked for ${state.incidentId}`
      : `${shown} document${shown === 1 ? "" : "s"}`;
  }
  if (!shown) {
    root.innerHTML = `<p class="lib-hint">Nothing in this filter.</p>`;
    if (shelf && !reading) shelf.innerHTML = `<p class="lib-hint">Nothing in this filter.</p>`;
    return;
  }
  const scale = related.length ? matchScaler(related) : null;
  root.innerHTML =
    libGroup("For this case", ground.map((g) => libItem(g.doc, { why: g.why })).join(""), "is-ground") +
    libGroup(
      "Related by search",
      related.map((doc) => libItem(doc, { match: scale ? scale(doc) : null })).join("")
    ) +
    libGroup(state.incidentId ? "Everything else" : "All documents", rest.map((doc) => libItem(doc)).join(""));
  if (shelf && !reading) {
    renderLibraryShelf(
      [...ground.map((g) => g.doc), ...related, ...rest],
      { grounded: ground }
    );
  }
  root.querySelector(".lib-item.is-on")?.scrollIntoView({ block: "nearest" });
}

function libCard(doc, opts = {}) {
  const kind = libraryKind(doc);
  const close = libraryClose(doc);
  return `<button type="button" class="lib-card kind-${kind}" data-doc="${escapeHtml(doc.id)}">
    <span class="kind-chip kind-${kind}">${escapeHtml(libraryKindLabel(doc))}</span>
    <span class="id">${escapeHtml(doc.id)}</span>
    <span class="use">${escapeHtml(libraryUse(doc))}</span>
    ${close ? `<span class="close-line">${escapeHtml(close)}</span>` : ""}
    ${opts.why ? `<span class="lib-why">${escapeHtml(opts.why)}</span>` : ""}
  </button>`;
}

function renderLibraryShelf(docs, opts = {}) {
  const shelf = $("library-shelf");
  if (!shelf) return;
  if (opts.searching) {
    shelf.innerHTML = `<p class="eyebrow">Search</p>
      <h2>${docs.length} match${docs.length === 1 ? "" : "es"}</h2>
      <p class="lib-shelf-lede">Pick a document in the index — procedures, similar cases, and filed close-outs stay on the same page.</p>
      <div class="lib-shelf-grid">${docs.map((doc) => libCard(doc)).join("")}</div>`;
    return;
  }
  const byKind = { procedure: [], history: [], filed: [] };
  const whyFor = new Map((opts.grounded || []).map((g) => [g.doc.id, g.why]));
  for (const doc of docs) byKind[libraryKind(doc)]?.push(doc);
  const groups = [
    { id: "procedure", title: "Procedures", lede: "The book. What to check before you guess." },
    { id: "history", title: "Similar cases", lede: "Prior signatures on this craft. Same fault family, already closed." },
    { id: "filed", title: "Filed close-outs", lede: "Decisions recorded here. The command was not sent." },
  ];
  const head = state.incidentId
    ? `<p class="eyebrow">Ranked for ${escapeHtml(state.incidentId)}</p>
       <h2>What this case is built on</h2>
       <p class="lib-shelf-lede">Procedure, same signature, and the filed record if it exists. Search above to look past this case.</p>`
    : `<p class="eyebrow">Aurora-1</p>
       <h2>The book</h2>
       <p class="lib-shelf-lede">Read a procedure the way it was written. Compare it to a prior close. Filing still does not uplink.</p>`;
  shelf.innerHTML =
    head +
    groups
      .map((g) => {
        const items = byKind[g.id];
        if (!items.length) return "";
        return `<section class="lib-shelf-group">
          <p class="family-head">${escapeHtml(g.title)}</p>
          <p class="hint">${escapeHtml(g.lede)}</p>
          <div class="lib-shelf-grid">${items.map((doc) => libCard(doc, { why: whyFor.get(doc.id) })).join("")}</div>
        </section>`;
      })
      .join("");
}

async function searchLibrary(query, opts = {}) {
  const q = (query || "").trim();
  /* A grounded fetch ranks the shelf for the open case; it is not a user query. */
  state.libraryQuery = opts.grounded ? "" : q;
  if (!q) {
    state.libraryHits = null;
    renderLibrary();
    return;
  }
  state.librarySearching = true;
  renderLibrary();
  try {
    const res = await fetch(`/search?q=${encodeURIComponent(q)}&limit=20`);
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
  state.libraryQuery = "";
  if (!state.incidentId) {
    browseLibrary();
    return;
  }
  searchLibrary(likeThisQuery(), { grounded: true });
}

function browseLibrary() {
  state.libraryQuery = "";
  state.libraryHits = null;
  const input = $("library-q");
  if (input) input.value = "";
  renderLibrary();
}

function focusLibrarySearch() {
  enterLibrary();
  const input = $("library-q");
  if (input) {
    input.focus();
    input.select();
  }
}

function moveLibrarySelection(delta) {
  const ids = state.libraryVisibleIds || [];
  if (!ids.length) return;
  const cur = ids.indexOf(state.openDocId);
  const idx =
    cur < 0 ? (delta > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, cur + delta));
  const next = ids[idx];
  if (next && next !== state.openDocId) openDoc(next);
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
    searchLibrary(q);
  }, 200);
}

async function refreshDocs() {
  const res = await fetch("/documents");
  if (!res.ok) return;
  state.docs = await res.json();
  renderLibrary();
}

function bind() {
  $("tab-home").addEventListener("click", () => goHome());
  $("tab-incidents").addEventListener("click", () => goIncidents());
  $("tab-library").addEventListener("click", () => goLibrary());
  $("tab-trust").addEventListener("click", () => goTrust());
  $("store-status").addEventListener("click", () => goTrust());
  $("back-incidents").addEventListener("click", () => goIncidents());
  $("go-home-brand").addEventListener("click", () => goHome());
  $("tape-trigger").addEventListener("click", () => {
    if (state.tapePaletteOpen) closeTapePalette();
    else openTapePalette();
  });
  $("tape-palette-close").addEventListener("click", closeTapePalette);
  $("tape-palette").addEventListener("click", (ev) => {
    if (ev.target.id === "tape-palette") closeTapePalette();
  });
  $("tape-palette-q").addEventListener("input", (ev) => {
    state.tapePaletteQuery = ev.target.value;
    renderTapePalette();
  });
  $("tape-palette-list").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tape]");
    if (!btn) return;
    loadDesk(btn.dataset.tape);
    closeTapePalette();
  });
  $("home").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-go-incidents]")) {
      goIncidents();
      return;
    }
    if (ev.target.closest("[data-open-slip]")) {
      openSlip();
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
    const filter = ev.target.closest("[data-filter]");
    if (filter) {
      state.incidentFilter = filter.dataset.filter;
      renderIncidents();
      return;
    }
    const btn = ev.target.closest("[data-open-case]");
    if (btn) openIncident(btn.dataset.openCase, btn.dataset.jump);
  });
  $("incidents-desk").addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const row = ev.target.closest("[data-open-case]");
    if (!row || ev.target !== row) return;
    ev.preventDefault();
    openIncident(row.dataset.openCase, row.dataset.jump);
  });
  initSpine();
  $("library-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    window.clearTimeout(libraryTimer);
    const q = $("library-q").value.trim();
    if (!q) {
      followThisCase();
      return;
    }
    searchLibrary(q);
  });
  $("library-q").addEventListener("input", onLibraryTyped);
  $("library-clear").addEventListener("click", () => {
    window.clearTimeout(libraryTimer);
    followThisCase();
    $("library-q").focus();
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
  $("library-kinds").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-kind]");
    if (!btn) return;
    state.libraryKind = btn.dataset.kind;
    renderLibrary();
  });
  $("library-families").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-family]");
    if (!btn) return;
    state.libraryFamily = btn.dataset.family;
    renderLibrary();
  });
  $("library-suggest").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-for-case]")) {
      window.clearTimeout(libraryTimer);
      followThisCase();
      return;
    }
    const chip = ev.target.closest("[data-suggest]");
    if (!chip) return;
    window.clearTimeout(libraryTimer);
    const q = chip.dataset.suggest;
    const input = $("library-q");
    if (input) input.value = q;
    searchLibrary(q);
  });
  $("library-desk").addEventListener("click", (ev) => {
    const listed = ev.target.closest("[data-open-listed]");
    if (listed) {
      openIncident(listed.dataset.openListed);
      return;
    }
    const btn = ev.target.closest("[data-doc]");
    if (btn) openDoc(btn.dataset.doc);
  });
  $("trust-desk").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-trust-overview]")) {
      goHome();
      return;
    }
    if (ev.target.closest("[data-trust-library]")) {
      goLibrary();
      return;
    }
    if (ev.target.closest("[data-trust-incidents]")) {
      goIncidents();
      return;
    }
    const tape = ev.target.closest("[data-trust-tape]");
    if (tape) {
      loadDesk(tape.dataset.trustTape).then(() => {
        if (state.view === "trust") renderTrust();
        goHome();
      });
      return;
    }
    const inspect = ev.target.closest("[data-trust-inspect]");
    if (inspect) {
      openInspector({ runId: inspect.dataset.trustInspect });
      return;
    }
    const doc = ev.target.closest("[data-trust-doc]");
    if (doc) {
      goLibrary();
      openDoc(doc.dataset.trustDoc);
    }
  });
  $("inspect-tape-btn")?.addEventListener("click", () => {
    if (!state.runId && !state.incident) return;
    openInspector({
      runId: state.runId,
      channel: alarmChannel(),
      alarm: alarmChannel(),
      window: state.window,
    });
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
  $("timeline").addEventListener("click", (ev) => {
    const node = ev.target.closest("[data-t]");
    if (!node) return;
    pinTape(node.dataset.t);
  });
  $("case-desk").addEventListener("click", (ev) => {
    const verdict = ev.target.closest("[data-fb-verdict]");
    if (verdict) {
      verdict.closest(".fb-toggle")?.querySelectorAll("[data-fb-verdict]").forEach((btn) => {
        btn.classList.toggle("is-on", btn === verdict);
      });
      return;
    }
    const saveFb = ev.target.closest("[data-save-feedback]");
    if (saveFb) {
      saveFeedback(saveFb.closest("#decide-feedback-root, #file-feedback"));
      return;
    }
    const jump = ev.target.closest("[data-case-jump]");
    if (!jump) return;
    const where = jump.dataset.caseJump;
    if (where === "closeout") {
      if (state.incidentId) openDoc(state.incidentId);
      return;
    }
    if (where === "action") {
      $("action")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    $("compare")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("findings-body").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-t]");
    if (!btn) return;
    pinTape(btn.dataset.t, { scroll: true });
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
  $("file-slip").addEventListener("click", (ev) => {
    const verdict = ev.target.closest("[data-fb-verdict]");
    if (verdict) {
      verdict.closest(".fb-toggle")?.querySelectorAll("[data-fb-verdict]").forEach((btn) => {
        btn.classList.toggle("is-on", btn === verdict);
      });
      return;
    }
    const saveFb = ev.target.closest("[data-save-feedback]");
    if (saveFb) {
      saveFeedback(saveFb.closest("#file-feedback"));
    }
  });
  $("cancel-file").addEventListener("click", closeFileSlip);
  $("file-slip").addEventListener("click", (ev) => {
    if (ev.target.id === "file-slip") closeFileSlip();
  });
  const openCloseout = () => {
    if (state.incidentId) openDoc(state.incidentId);
  };
  $("open-closeout").addEventListener("click", openCloseout);
  $("open-closeout-case").addEventListener("click", openCloseout);
  $("open-proc").addEventListener("click", () => openDoc(procedureId(analysis())));
  $("reader-close").addEventListener("click", closeReader);
  document.addEventListener("keydown", (ev) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(ev.target?.tagName || "");
    if ((ev.key === "k" || ev.key === "K") && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      focusLibrarySearch();
      return;
    }
    if (ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      focusLibrarySearch();
      return;
    }
    if ((ev.key === "ArrowDown" || ev.key === "ArrowUp") && state.view === "library" && (!typing || ev.target?.id === "library-q")) {
      ev.preventDefault();
      moveLibrarySelection(ev.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (ev.key !== "Escape") return;
    if (state.tapePaletteOpen) {
      closeTapePalette();
      return;
    }
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
    if (state.libraryQuery) {
      window.clearTimeout(libraryTimer);
      followThisCase();
    }
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
  bind();
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
  const tape =
    state.incidents.find((item) => item.id === "INC-0204")?.run_id ||
    state.runs.find((run) => run.id === "eps204")?.id ||
    state.runs[0]?.id ||
    "eps204";
  enterHome();
  await loadDesk(tape);
}

boot().catch((err) => {
  const lede = $("home-lede");
  if (lede) lede.textContent = err.message;
});
