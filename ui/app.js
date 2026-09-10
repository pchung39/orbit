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
  if (status === "recommended") return "Ready for review";
  if (status === "filed") return "Assessment recorded";
  return "Not investigated";
}

function incStatusChip(status) {
  const st = status || "open";
  const cls = st === "recommended" ? "ready" : st;
  return `<span class="chip chip-${cls} inc-status">${escapeHtml(statusLabel(st))}</span>`;
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
  if (!isGenericCaseTitle(item)) return (item.title || "").trim();
  const notesClock = String(item.notes || "").match(/@\s*(\d{2}:\d{2}:\d{2})/);
  return suggestCaseTitle(item.alarm, item.run_id, notesClock?.[1] || openedClock(item.opened_at), item.notes);
}

function tapeGroupKey(item) {
  return sourceRunId(item.run_id, item.notes) || "other";
}

function tapeGroupLabel(key) {
  if (key === "other") return "Other tapes";
  const copy = tapeCopy({ id: key });
  return `${copy.kind} · ${copy.title}`;
}

const TAPE_GROUP_ORDER = ["fault1", "eps204", "marg001", "pay002", "batt003", "nominal", "other"];

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
  if (item.status === "recommended") return { jump: "action", label: "Record assessment" };
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

function stopInvestigationAnimation() {
  if (investigationStepTimer) {
    window.clearInterval(investigationStepTimer);
    investigationStepTimer = null;
  }
}

function renderInvestigationProgress() {
  const body = $("findings-body");
  if (!body || !state.investigating) return;
  body.innerHTML = `<div class="investigation-progress" aria-live="polite" aria-busy="true">
    <p class="investigation-progress-kicker">Investigation in progress</p>
    <p class="investigation-progress-copy">Reviewing case evidence and preparing the report.</p>
  </div>`;
  document.body.classList.add("is-investigating");
  announceLive("Investigation in progress. Reviewing case evidence and preparing the report.");
}

function announceLive(message) {
  const el = $("investigation-live");
  if (!el) return;
  el.textContent = "";
  window.setTimeout(() => {
    el.textContent = message;
  }, 20);
}

function workingGuess(a) {
  if (!a) return null;
  const heaterA = a.heaterAAtCmd ?? a.heaterA;
  const ratio = a.ratioAtCmd ?? a.ratio;
  if (a.suspect) {
    return {
      suspect: `Heater B ${fmt(heaterA, 2)} A · ${fmt(ratio, 1)}× healthy max`,
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
      suspect: ratio != null
        ? `Heater B ${fmt(heaterA, 2)} A · ${fmt(ratio, 1)}× — below ≥2× threshold`
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

function isHoldFeedback(a, fb) {
  return Boolean(a?.withheld || fb?.hypothesis_key === "WITHHELD");
}

function feedbackVerdictLabel(verdict, isHold) {
  if (isHold) {
    return verdict === "confirmed" ? "Agreed with hold" : "Disagreed with hold";
  }
  return verdict === "confirmed" ? "Agreed with assessment" : "Disagreed with assessment";
}

function feedbackFormHtml({ editable, compact, noteId = "feedback-note", mode = "hypothesis" }) {
  const fb = state.feedback;
  const verdict = activeFeedbackVerdict();
  const note = fb?.note || "";
  const isHold = mode === "hold";
  const kicker = isHold ? "Operator assessment" : "Operator assessment";
  const aria = isHold ? "Agree or disagree with the hold recommendation" : "Agree or disagree with the assessment";
  const hint = isHold
    ? "Stored with this case for local review and future eval export. Does not change the recommendation, send a command, or confirm a physical fault. A third “need more evidence” state is not persisted yet."
    : "Stored with this case for local review and future eval export. Does not change the recommendation, send a command, or confirm a physical fault. A third “need more evidence” state is not persisted yet.";
  if (!editable) {
    if (!fb) return "";
    const hold = isHoldFeedback(analysis(), fb);
    const label = feedbackVerdictLabel(verdict, hold);
    const key = hold ? "Hold · do not command" : fb.hypothesis_key || "";
    return `<div class="guess-feedback is-readonly">
      <p class="guess-kicker">${escapeHtml(label)}</p>
      <p class="guess-fb-key">${escapeHtml(key)}</p>
      ${note ? `<p class="guess-fb-note">${escapeHtml(note)}</p>` : ""}
    </div>`;
  }
  return `<div class="guess-feedback ${compact ? "is-compact" : ""}">
    <p class="guess-kicker">${escapeHtml(kicker)}</p>
    <div class="fb-toggle" role="group" aria-label="${escapeHtml(aria)}">
      <button type="button" class="fb-opt ${verdict === "confirmed" ? "is-on" : ""}" data-fb-verdict="confirmed">Agree with assessment</button>
      <button type="button" class="fb-opt ${verdict === "rejected" ? "is-on" : ""}" data-fb-verdict="rejected">Disagree</button>
    </div>
    <label class="fb-note-label">Note <span class="opt">optional · stored with this case</span>
      <textarea class="feedback-note" id="${noteId}" rows="2" placeholder="${isHold ? "Why hold was or was not the right call…" : "Why you agree or disagree…"}">${escapeHtml(note)}</textarea>
    </label>
    ${compact ? "" : `<p class="hint fb-hint">${escapeHtml(hint)}</p>`}
    <div class="guess-feedback-actions">
      <button type="button" class="btn btn-ghost btn-sm fb-save" data-save-feedback ${state.feedbackSaving ? "disabled" : ""}>${state.feedbackSaving ? "Saving…" : fb ? "Update assessment" : "Save assessment"}</button>
    </div>
  </div>`;
}

function renderFileSlipFeedback() {
  const root = $("file-feedback");
  if (!root) return;
  const filed = state.incident?.status === "filed";
  const a = analysis();
  const mode = a?.withheld ? "hold" : "hypothesis";
  if (filed) {
    root.innerHTML = feedbackFormHtml({ editable: false, compact: true, mode });
    return;
  }
  if (state.feedback) {
    const hold = isHoldFeedback(a, state.feedback);
    const label = hold ? "Decision review" : "Hypothesis review";
    const key = hold ? "Hold · do not command" : state.feedback.hypothesis_key;
    root.innerHTML = `<div class="file-fb-summary">
      <p class="pick-label">${escapeHtml(label)}</p>
      <p class="guess-fb-key">${escapeHtml(key)} · ${escapeHtml(state.feedback.verdict)}</p>
      ${state.feedback.note ? `<p class="guess-fb-note">${escapeHtml(state.feedback.note)}</p>` : ""}
    </div>`;
    return;
  }
  root.innerHTML = feedbackFormHtml({ editable: true, compact: true, noteId: "file-feedback-note", mode });
}

async function saveFeedback(scopeEl) {
  if (!state.incidentId || state.feedbackSaving || state.incident?.status === "filed") return;
  const scope = scopeEl || $("decide-feedback-root");
  const on = scope?.querySelector("[data-fb-verdict].is-on");
  if (!on) {
    window.alert("Choose Agree with assessment or Disagree first.");
    return;
  }
  const noteEl = scope.querySelector(".feedback-note");
  const note = noteEl?.value.trim() || null;
  state.feedbackSaving = true;
  renderDecision(analysis());
  renderFileSlipFeedback();
  try {
    const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(state.incidentId)}/feedback`), {
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
  const lastLabel = a?.science && g.last.includes("SCIENCE_MODE")
    ? `${g.last} · most recent mode change`
    : g.last;
  if (g.withheld) {
    return `<dl class="hyp-context">
      <div><dt>Status</dt><dd>${escapeHtml(g.suspect)}</dd></div>
      <div><dt>Last command</dt><dd>${escapeHtml(lastLabel)}</dd></div>
      <div class="is-act"><dt>Decision</dt><dd>${escapeHtml(g.recommend)} <i>no command</i></dd></div>
    </dl>`;
  }
  return `<dl class="hyp-context">
    <div><dt>Suspect load</dt><dd>${escapeHtml(g.suspect)}</dd></div>
    <div><dt>Last command</dt><dd>${escapeHtml(lastLabel)}</dd></div>
    <div class="is-act"><dt>Recommend</dt><dd>${escapeHtml(g.recommend)} <i>not sent</i></dd></div>
  </dl>`;
}

function renderDecisionContext(a) {
  const hypRoot = $("decide-hypothesis");
  const fbRoot = $("decide-feedback-root");
  const inc = state.incident;
  const filed = inc?.status === "filed";
  const g = workingGuess(a);
  const showHyp = Boolean(a && g && inc && !filed && hasSuccessfulInvestigation());

  if (hypRoot) {
    if (showHyp) {
      hypRoot.hidden = false;
      const kicker = g.withheld ? "Recommended hold" : "Working hypothesis";
      hypRoot.innerHTML = `<p class="decide-section-kicker">${kicker}</p>${hypothesisContextHtml(a, g)}`;
    } else {
      hypRoot.hidden = true;
      hypRoot.innerHTML = "";
    }
  }

  if (fbRoot) {
    const showFb = inc && !filed && hasSuccessfulInvestigation();
    const mode = g?.withheld ? "hold" : "hypothesis";
    if (showFb) {
      fbRoot.hidden = false;
      fbRoot.innerHTML = feedbackFormHtml({ editable: true, compact: false, noteId: "decide-feedback-note", mode });
    } else if (filed && (state.feedback || inc?.feedback)) {
      fbRoot.hidden = false;
      fbRoot.innerHTML = feedbackFormHtml({
        editable: false,
        compact: false,
        mode: isHoldFeedback(a, state.feedback || inc?.feedback) ? "hold" : "hypothesis",
      });
    } else {
      fbRoot.hidden = true;
      fbRoot.innerHTML = "";
    }
  }
}

function caseFactHtml(k, v, tone, sub) {
  return `<div class="fact ${tone ? `is-${tone}` : ""}">
    <dt>${escapeHtml(k)}</dt>
    <dd>${escapeHtml(v)}${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}</dd>
  </div>`;
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

function tracesToDraw() {
  const alarm = alarmChannel();
  return TRACE_CATALOG.map((ch) => ({ ...ch, primary: ch.id === alarm }));
}

const DEMO_STORY = [
  {
    id: "INC-0204",
    n: "1",
    title: "Run an investigation",
    blurb: "Open INC-0204 and inspect the recommendation.",
    primary: true,
  },
  {
    id: "INC-0212",
    n: "2",
    title: "Compare a hold case",
    blurb: "Open INC-0212 to see what happens when the evidence does not meet the procedure’s threshold.",
  },
  {
    id: null,
    n: "3",
    title: "Inspect the evaluations",
    blurb: "Review the checks behind the published results.",
    trust: true,
  },
];

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
  pathExpanded: false,
  window: "focus",
  pinT: null,
  pinSource: null,
  hoverT: null,
  report: null,
  investigating: false,
  evidenceOpen: true,
  procedureOpen: false,
  knowledgeOpen: false,
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
  trustSub: "overview",
  releaseCaseId: null,
  releaseCompare: null,
  evalExplorer: null,
  releaseLoading: false,
  releaseCase: null,
  sources: null,
  sourcesLoading: false,
  sourcesSyncing: null,
  archiveCatalog: [],
  sourceExplorer: {
    category: "datasets",
    docFilter: "all",
    selectedId: null,
    listScroll: 0,
    detailOpen: false,
  },
  maintStatus: null,
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

function pinTimePool() {
  const pool = [];
  for (const e of state.workspace?.events || []) {
    if (e.time_s != null) pool.push(Number(e.time_s));
  }
  const a = analysis();
  if (a?.warn?.time_s != null) pool.push(Number(a.warn.time_s));
  if (a?.t != null) pool.push(Number(a.t));
  for (const spec of tracesToDraw()) {
    for (const row of series(spec.id)) {
      if (row.time_s != null) pool.push(Number(row.time_s));
    }
  }
  return pool;
}

function nearestPinTime(target, pool) {
  if (!pool.length) return target;
  const want = clock(target);
  const sameClock = pool.filter((t) => clock(t) === want);
  const list = sameClock.length ? sameClock : pool;
  return list.reduce((best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best), list[0]);
}

/** Map a clock string or approximate time_s to the nearest sample/event in this workspace. */
function resolvePinTime(raw) {
  if (raw == null || raw === "") return null;
  const text = String(raw).trim();
  let target = text.includes(":") ? clockToS(text) : Number(text);
  if (Number.isNaN(target)) return null;
  return nearestPinTime(target, pinTimePool());
}

function isPinnedAt(t) {
  const pin = state.pinT;
  return pin != null && t != null && Math.abs(Number(pin) - Number(t)) < 2.6;
}

function timelinePinTime(text, kids = []) {
  const clockTime = firstClock(text) || firstClock(kids[0] || "");
  if (clockTime) return resolvePinTime(clockTime);
  if (/\bat the warn\b/i.test(text)) {
    const a = analysis();
    return a?.t != null ? resolvePinTime(a.t) : null;
  }
  return null;
}

function isLeadUpPinned(t) {
  const id = `tl:${t}`;
  if (state.pinSource) return state.pinSource === id;
  return isPinnedAt(t);
}

function isEvPinned(id) {
  return state.pinSource === id;
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
    .map((tag) => {
      const cls = tagClass(tag);
      const title = TAG_MEANING[cls] || "";
      return `<span class="tag tag-${cls}" title="${escapeHtml(title)}" tabindex="0">${escapeHtml(tag)}</span>`;
    })
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
      const kind = itemKind(text, tags);
      const rowId = `ev:${item.n}`;
      const pinTs = timelinePinTime(text, item.kids);
      const pin = pinTs != null ? ` data-t="${pinTs}" data-pin-id="${rowId}"` : "";
      const on = isEvPinned(rowId) ? " is-on" : "";
      const kids = item.kids
        .map((kid, kidIdx) => {
          const parsed = parseKid(kid);
          const kidId = `${rowId}:kid:${kidIdx}`;
          const kidTs = parsed.clock ? resolvePinTime(parsed.clock) : null;
          const kidPin = kidTs != null ? ` data-t="${kidTs}" data-pin-id="${kidId}"` : "";
          const kidOn = isEvPinned(kidId) ? " is-on" : "";
          return `<button type="button" class="ev-kid${kidOn}"${kidPin}>
            <span class="ev-clock">${parsed.clock || ""}</span>
            <span>${parsed.html}</span>
          </button>`;
        })
        .join("");
      const clockTime = firstClock(text) || firstClock(item.kids[0] || "") || (pinTs != null ? clock(pinTs) : "");
      return `<li class="ev-item ev-${kind}${on}">
        <button type="button" class="ev-main${on}"${pin}>
          <span class="ev-n">${String(item.n).padStart(2, "0")}</span>
          <span class="ev-clock">${clockTime || "—"}</span>
          <span class="ev-copy">${inlineMd(text)}</span>
          <span class="ev-tags">${tagsHtml(tags)}</span>
        </button>
        ${kids ? `<div class="ev-kids">${kids}</div>` : ""}
      </li>`;
    })
    .join("");
  return `<article class="finding evidence">
    <h3>Event timeline</h3>
    <p class="hint">Select a row to pin that time on the evidence snapshot.</p>
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

function pinTape(t, { scroll = false, source = null } = {}) {
  const n = resolvePinTime(t);
  if (n == null || Number.isNaN(n)) return;
  state.pinT = n;
  state.pinSource = source;
  state.hoverT = null;
  renderMode(analysis());
  renderTraces();
  renderTimeline(analysis());
  updateReadouts();
  if (state.view === "case") {
    state.evidenceOpen = true;
    syncEvidenceBundle();
  }
  if (state.report) renderFindings();
  if (scroll) $("traces")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateReadouts() {
  const a = analysis();
  if (state.view === "home" || state.view === "incidents") {
    return;
  }
  const tPin = state.pinT ?? a?.t;
  const tHover = state.hoverT;
  const t = tHover ?? tPin;
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
  { id: "open", label: "Not investigated", match: (item) => item.status !== "filed" && item.status !== "recommended" },
  { id: "ready", label: "Ready for review", match: (item) => item.status === "recommended" },
  { id: "filed", label: "Assessment recorded", match: (item) => item.status === "filed" },
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
  const statusCounts = {
    all: counts.nAll,
    open: counts.nOpen,
    ready: counts.nReady,
    filed: counts.nFiled,
  };
  const statusOpts = INC_FILTERS.map((f) => {
    const n = statusCounts[f.id] ?? 0;
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

function groupIncidentsByTape(rows) {
  const groups = new Map();
  for (const item of rows) {
    const key = tapeGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const ordered = [
    ...TAPE_GROUP_ORDER.filter((key) => groups.has(key)),
    ...[...groups.keys()].filter((key) => !TAPE_GROUP_ORDER.includes(key)).sort(),
  ];
  return ordered.map((key) => ({
    key,
    label: tapeGroupLabel(key),
    items: groups.get(key),
  }));
}

function renderIncidents() {
  const all = [...state.incidents];
  const count = (id) => all.filter(INC_FILTERS.find((f) => f.id === id).match).length;
  const nOpen = count("open");
  const nReady = count("ready");
  const nFiled = count("filed");
  const rows = sortIncidents(filterIncidents(all));

  const tabN = $("tab-incidents-n");
  if (tabN) tabN.textContent = nOpen + nReady ? String(nOpen + nReady) : "";

  const hero = $("inc-head");
  if (hero) {
    hero.innerHTML = `
      <p class="inc-kicker">
        <span class="inc-kicker-craft">Aurora-1</span>
        <span class="inc-kicker-rule" aria-hidden="true"></span>
        <span class="inc-kicker-role">case log</span>
      </p>
      <h1 class="inc-title">Incidents</h1>`;
  }
  renderIncFilters(all, { nOpen, nReady, nFiled, nAll: all.length });

  const meta = $("inc-meta");
  if (meta) {
    const q = (state.incidentQuery || "").trim();
    const notes = [];
    if (state.incidentFilter !== "all") {
      notes.push(INC_FILTERS.find((f) => f.id === state.incidentFilter)?.label || "");
    }
    if (state.incidentFamily && state.incidentFamily !== "all") {
      notes.push(INC_CATEGORY_LABELS[state.incidentFamily] || state.incidentFamily);
    }
    if (state.incidentTape && state.incidentTape !== "all") {
      notes.push(tapeGroupLabel(state.incidentTape));
    }
    const note = notes.filter(Boolean).join(" · ");
    meta.textContent = `${rows.length} case${rows.length === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}${note ? ` · ${note}` : ""}`;
  }

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
  const grouped = groupIncidentsByTape(rows);
  const useFlat = grouped.length === 1;
  list.innerHTML = useFlat
    ? `${cols}${rows.map((item) => incRow(item, all)).join("")}`
    : grouped
        .map(
          (group) => `<section class="inc-group tone-${incidentTone(group.items[0] || {})}">
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
  const copy = tapeCopy({ id: item.run_id, notes: item.notes });
  const bits = [
    `<span class="chip chip-xs inc-alarm-chip">${escapeHtml(alarmShort(item.alarm))}</span>`,
    `<span class="inc-tape-kind">${escapeHtml(copy.kind)}</span>`,
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
        <span class="k">${escapeHtml(ch.id)}</span>
        <span class="note">warn ${ch.warn_limit} ${ch.unit || ""}</span>
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

function trustTone(ok, warn) {
  if (ok) return "ok";
  if (warn) return "warn";
  return "bad";
}

async function loadTrust() {
  state.trustLoading = true;
  state.releaseCompare = null;
  state.evalExplorer = null;
  renderTrust();
  try {
    const [trustRes, sourcesRes, compareRes, explorerRes] = await Promise.all([
      fetch(apiUrl("/trust")),
      fetch(apiUrl("/sources")),
      fetch(apiUrl("/eval/compare")),
      fetch(apiUrl("/eval/explorer")),
    ]);
    if (!trustRes.ok) throw new Error(`trust ${trustRes.status}`);
    state.trust = await trustRes.json();
    if (sourcesRes.ok) {
      state.sources = await sourcesRes.json();
    } else {
      state.sources = null;
    }
    if (compareRes.ok) {
      state.releaseCompare = await compareRes.json();
    } else {
      state.releaseCompare = {
        error: `compare ${compareRes.status}`,
        recommendation: "INSUFFICIENT_COVERAGE",
        explanation: "Could not load release comparison.",
        metrics: [],
        cases: { improved: 0, unchanged: 0, regressed: 0, rows: [] },
        blockers: [],
        warnings: [],
      };
    }
    if (explorerRes.ok) {
      state.evalExplorer = await explorerRes.json();
    } else {
      state.evalExplorer = null;
    }
  } catch (err) {
    state.trust = null;
    state.sources = null;
    state.releaseCompare = {
      error: err.message,
      recommendation: "INSUFFICIENT_COVERAGE",
      explanation: "Trust or release API unavailable.",
      metrics: [],
      cases: { improved: 0, unchanged: 0, regressed: 0, rows: [] },
      blockers: [],
      warnings: [],
    };
    state.evalExplorer = null;
    if ($("trust-head")) {
      $("trust-head").innerHTML = `<h1>Can I trust this?</h1><p class="trust-head-lede">${escapeHtml(err.message)}</p>`;
    }
  } finally {
    state.trustLoading = false;
    await loadArchiveCatalog();
    renderTrust();
    if (state.view === "home") renderHomeProof();
  }
}

async function syncSource(connectorId) {
  if (state.sourcesSyncing) return;
  state.sourcesSyncing = connectorId;
  state.maintStatus = {
    tone: "loading",
    message: connectorId === "telemetry" ? "Refreshing dataset catalog…" : "Rebuilding document search index…",
  };
  renderTrust();
  try {
    const res = await fetch(apiUrl(`/sources/${encodeURIComponent(connectorId)}/sync`), { method: "POST" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `sync ${res.status}`);
    }
    const data = await res.json();
    if (!state.sources) state.sources = { connectors: [], activity: [] };
    state.sources.activity = data.activity || state.sources.activity || [];
    state.sources.connectors = (state.sources.connectors || []).map((c) =>
      c.id === data.connector?.id ? data.connector : c
    );
    if (data.connector && !(state.sources.connectors || []).some((c) => c.id === data.connector.id)) {
      state.sources.connectors = [...(state.sources.connectors || []), data.connector];
    }
    state.maintStatus = {
      tone: "ok",
      message:
        connectorId === "telemetry"
          ? "Dataset catalog refreshed. Saved snapshots and cases were not changed."
          : "Document search index rebuilt. Sealed snapshots and reports were not rewritten.",
    };
    await loadTrust();
    await loadBootstrapLists();
    if (connectorId === "telemetry") await loadArchiveCatalog();
  } catch (err) {
    state.maintStatus = {
      tone: "bad",
      message: err.message || "Could not update source",
    };
    window.alert(err.message || "Could not update source");
    renderTrust();
  } finally {
    state.sourcesSyncing = null;
    renderTrust();
  }
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

function formatSyncAt(iso) {
  if (!iso) return "Never";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (err) {
    return iso;
  }
}

function formatMissionSpan(start, end) {
  if (!start && !end) return "—";
  if (start && end) return `${start}–${end} UTC`;
  return `${start || end} UTC`;
}

function documentOriginLabel(doc) {
  const path = String(doc?.path || "");
  if (path.startsWith("filed:")) return "Filed investigation";
  if (/\/procedures\//.test(path) || path.includes("procedures/")) return "Local procedure";
  if (/\/incidents\//.test(path) || path.includes("incidents/")) return "Prior incident record";
  if (doc?.kind === "procedure") return "Local procedure";
  if (doc?.kind === "incident") return "Prior incident record";
  return null;
}

function documentShortDescription(doc) {
  const use = libraryUse(doc);
  if (use && use !== doc.id) return use;
  const title = String(doc?.title || "").trim();
  if (title && title !== doc.id) return title;
  return "";
}

function incidentsForRun(runId) {
  return (state.incidents || []).filter((item) => item.run_id === runId);
}

function ingestedRunIds() {
  const fromTrust = (state.trust?.runs || [])
    .map((run) => String(run.id))
    .filter((id) => !id.startsWith("sealed_"));
  const fromRuns = (state.runs || []).map((run) => String(run.id)).filter((id) => !id.startsWith("sealed_"));
  return new Set([...fromTrust, ...fromRuns]);
}

function explorerDatasets() {
  return sortTapes(archiveRunsOnly());
}

function explorerSnapshots() {
  const sealed = (state.trust?.runs || []).filter((run) => String(run.id).startsWith("sealed_"));
  return [...sealed].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function explorerDocuments() {
  const docs = state.trust?.documents || state.docs || [];
  const filter = state.sourceExplorer.docFilter;
  return docs.filter((doc) => {
    if (filter === "procedures") return doc.kind === "procedure";
    if (filter === "incidents") return doc.kind === "incident";
    return true;
  });
}

function explorerCounts() {
  const docs = state.trust?.documents || state.docs || [];
  return {
    datasets: explorerDatasets().length,
    snapshots: explorerSnapshots().length,
    documents: docs.length,
  };
}

function rememberExplorerListScroll() {
  const list = $("source-explorer-list");
  if (list) state.sourceExplorer.listScroll = list.scrollTop;
}

function restoreExplorerListScroll() {
  const list = $("source-explorer-list");
  if (list) list.scrollTop = state.sourceExplorer.listScroll || 0;
}

function setExplorerCategory(category) {
  if (state.sourceExplorer.category === category) return;
  rememberExplorerListScroll();
  state.sourceExplorer.category = category;
  state.sourceExplorer.selectedId = null;
  state.sourceExplorer.detailOpen = false;
  state.sourceExplorer.listScroll = 0;
  renderSourceExplorer();
}

function setExplorerDocFilter(filter) {
  rememberExplorerListScroll();
  state.sourceExplorer.docFilter = filter;
  const stillVisible = explorerDocuments().some((doc) => doc.id === state.sourceExplorer.selectedId);
  if (!stillVisible) {
    state.sourceExplorer.selectedId = null;
    state.sourceExplorer.detailOpen = false;
  }
  state.sourceExplorer.listScroll = 0;
  renderSourceExplorer();
}

function selectExplorerRecord(id, { openDetail = true } = {}) {
  rememberExplorerListScroll();
  state.sourceExplorer.selectedId = id;
  state.sourceExplorer.detailOpen = Boolean(openDetail);
  renderSourceExplorer();
}

function closeExplorerDetail() {
  state.sourceExplorer.detailOpen = false;
  renderSourceExplorer();
}

function openSlipFromDataset(runId) {
  const bound = (state.alarms || []).find((alarm) => alarm.bind?.run_id === runId);
  openSlip();
  if (bound) setPick("alarm", bound.id);
  setPick("run", runId);
  syncSuggestedTitle();
}

function openInspectorForSnapshot(run) {
  const defaults = defaultInspectForRun(sourceRunId(run.id, run.notes));
  openInspector({
    runId: run.id,
    channel: defaults.channel,
    alarm: defaults.alarm,
    window: "full",
    savedClockStart: run.clock_start || null,
    savedClockEnd: run.clock_end || null,
    savedChannelValues: run.samples ?? null,
  });
}

function renderMaintenance() {
  const actions = $("source-maint-actions");
  const status = $("source-maint-status");
  const activityRoot = $("source-maint-activity");
  const activityList = $("source-maint-activity-list");
  if (!actions) return;

  const connectors = state.sources?.connectors || [];
  const byId = Object.fromEntries(connectors.map((c) => [c.id, c]));
  const telemetry = byId.telemetry;
  const library = byId.library;
  const syncing = state.sourcesSyncing;
  const telemetryBusy = syncing === "telemetry";
  const libraryBusy = syncing === "library";
  const anyBusy = Boolean(syncing);

  const telemetryLabel = telemetryBusy
    ? "Refreshing…"
    : "Refresh dataset catalog";
  const libraryLabel = libraryBusy ? "Rebuilding…" : "Rebuild document search index";

  actions.innerHTML = `
    <div class="source-maint-item">
      <button type="button" class="text-btn" data-source-sync="telemetry" ${anyBusy || !telemetry ? "disabled" : ""}>${escapeHtml(telemetryLabel)}</button>
      <p>Re-checks which upstream telemetry datasets are available for opening cases. Does not replace saved snapshots or change existing cases or reports.</p>
      ${telemetry?.stats?.label ? `<p class="source-maint-meta">${escapeHtml(telemetry.stats.label)}${telemetry.last_sync_at ? ` · last ${escapeHtml(formatSyncAt(telemetry.last_sync_at))}` : ""}</p>` : ""}
    </div>
    <div class="source-maint-item">
      <button type="button" class="text-btn" data-source-sync="library" ${anyBusy || !library ? "disabled" : ""}>${escapeHtml(libraryLabel)}</button>
      <p>Re-embeds procedures and prior incidents for search. Does not rewrite sealed snapshots, case reports, or recorded assessments.</p>
      ${library?.stats?.label ? `<p class="source-maint-meta">${escapeHtml(library.stats.label)}${library.last_sync_at ? ` · last ${escapeHtml(formatSyncAt(library.last_sync_at))}` : ""}</p>` : ""}
    </div>`;

  if (status) {
    if (state.maintStatus?.message) {
      status.hidden = false;
      status.className = `source-maint-status is-${state.maintStatus.tone || "ok"}`;
      status.textContent = state.maintStatus.message;
    } else {
      status.hidden = true;
      status.textContent = "";
    }
  }

  const activity = state.sources?.activity || [];
  if (activityRoot && activityList) {
    activityRoot.hidden = activity.length === 0;
    activityList.innerHTML = activity
      .slice(0, 6)
      .map(
        (ev) => `<li><span class="when">${escapeHtml(formatSyncAt(ev.at))}</span>
          <span class="conn">${escapeHtml(ev.connector === "telemetry" ? "datasets" : ev.connector === "library" ? "documents" : ev.connector || "")}</span>
          <span class="msg">${escapeHtml(ev.message || "")}</span></li>`
      )
      .join("");
  }
}

function renderExplorerDatasetDetail(run) {
  const copy = tapeCopy(run);
  const ingested = ingestedRunIds().has(run.id);
  const span = formatMissionSpan(run.clock_start, run.clock_end);
  const steps = run.samples != null ? `${Number(run.samples).toLocaleString()} time steps` : "—";
  const simNote = run.notes || copy.note || "";
  return `
    <div class="source-detail-head">
      <p class="source-detail-kicker">Dataset</p>
      <h3>${escapeHtml(copy.title)}</h3>
      <p class="source-detail-id"><code>${escapeHtml(run.id)}</code></p>
    </div>
    <dl class="source-detail-facts">
      <div><dt>Available range</dt><dd>${escapeHtml(span)}</dd></div>
      <div><dt>Recorded samples</dt><dd>${escapeHtml(steps)} <span class="source-detail-hint">CSV time steps in the upstream tape</span></dd></div>
      <div><dt>Origin</dt><dd>Mission archive (upstream)</dd></div>
    </dl>
    ${
      simNote
        ? `<details class="source-sim-notes"><summary>Simulation notes</summary><p>${escapeHtml(simNote)}</p><p class="source-detail-hint">Authored scenario context — not an investigation finding.</p></details>`
        : ""
    }
    <div class="source-detail-actions">
      <button type="button" class="btn" data-explorer-open-case="${escapeHtml(run.id)}">Open case from dataset</button>
      ${
        ingested
          ? `<button type="button" class="text-btn" data-explorer-inspect-dataset="${escapeHtml(run.id)}">Inspect dataset</button>`
          : `<p class="source-detail-hint">Raw source browsing creates no case. Use Open case from dataset to start the existing create flow.</p>`
      }
    </div>`;
}

function renderExplorerSnapshotDetail(run) {
  const copy = tapeCopy(run);
  const span = formatMissionSpan(run.clock_start, run.clock_end);
  const linked = incidentsForRun(run.id);
  const values =
    run.samples != null
      ? `${Number(run.samples).toLocaleString()} channel values`
      : "—";
  const linkedHtml = linked.length
    ? `<ul class="source-linked-cases">${linked
        .map(
          (inc) => `<li><button type="button" class="text-btn" data-explorer-open-incident="${escapeHtml(inc.id)}">Open linked case ${escapeHtml(inc.id)}</button></li>`
        )
        .join("")}</ul>`
    : `<p class="source-detail-hint">No linked case recorded</p>`;
  return `
    <div class="source-detail-head">
      <p class="source-detail-kicker">Saved snapshot</p>
      <h3>${escapeHtml(copy.title)}</h3>
      <p class="source-detail-id"><code>${escapeHtml(run.id)}</code></p>
    </div>
    <dl class="source-detail-facts">
      <div><dt>Saved window</dt><dd>${escapeHtml(span)}</dd></div>
      <div><dt>Stored values</dt><dd>${escapeHtml(values)} <span class="source-detail-hint">one row per channel at each time step</span></dd></div>
      <div><dt>Source dataset</dt><dd><code>${escapeHtml(sourceRunId(run.id, run.notes) || "—")}</code></dd></div>
      <div><dt>Linked incident</dt><dd>${linked.length ? escapeHtml(linked.map((i) => i.id).join(", ")) : "None recorded"}</dd></div>
    </dl>
    <div class="source-detail-actions">
      <button type="button" class="btn" data-explorer-inspect-snapshot="${escapeHtml(run.id)}">Inspect samples</button>
      ${linkedHtml}
    </div>`;
}

function renderExplorerDocumentDetail(doc) {
  const origin = documentOriginLabel(doc);
  const desc = documentShortDescription(doc);
  const typeLabel = doc.kind === "procedure" ? "Procedure" : doc.kind === "incident" ? "Prior incident" : doc.kind || "Document";
  return `
    <div class="source-detail-head">
      <p class="source-detail-kicker">Reference document</p>
      <h3>${escapeHtml(doc.title || doc.id)}</h3>
      <p class="source-detail-id"><code>${escapeHtml(doc.id)}</code></p>
    </div>
    <dl class="source-detail-facts">
      <div><dt>Type</dt><dd>${escapeHtml(typeLabel)}</dd></div>
      ${origin ? `<div><dt>Origin</dt><dd>${escapeHtml(origin)}</dd></div>` : ""}
      ${desc ? `<div><dt>Summary</dt><dd>${escapeHtml(desc)}</dd></div>` : ""}
    </dl>
    ${
      doc.path
        ? `<details class="source-tech-details"><summary>Technical details</summary><p class="source-detail-path"><code>${escapeHtml(doc.path)}</code></p></details>`
        : ""
    }
    <p class="source-detail-hint">Library membership does not mean this document was used in every report.</p>
    <div class="source-detail-actions">
      <button type="button" class="btn" data-explorer-read-doc="${escapeHtml(doc.id)}">Read document</button>
    </div>`;
}

function renderSourceExplorer() {
  const root = $("source-explorer");
  if (!root) return;

  if (state.trustLoading && !state.trust) {
    root.innerHTML = `<p class="trust-empty">Loading sources…</p>`;
    renderMaintenance();
    return;
  }
  if (!state.trust && !state.archiveCatalog?.length) {
    root.innerHTML = `<p class="trust-empty">Sources unavailable. Is the API running?</p>`;
    renderMaintenance();
    return;
  }

  const counts = explorerCounts();
  const category = state.sourceExplorer.category;
  const selectedId = state.sourceExplorer.selectedId;
  const detailOpen = state.sourceExplorer.detailOpen;

  let records = [];
  let intro = "";
  if (category === "datasets") {
    records = explorerDatasets();
    intro = "Source telemetry available for creating an investigation.";
  } else if (category === "snapshots") {
    records = explorerSnapshots();
    intro = "Saved telemetry windows available for investigation and review.";
  } else {
    records = explorerDocuments();
    intro =
      "Procedures and prior incidents available as investigation context. Library membership does not mean a document was used in every report.";
  }

  const selected =
    category === "documents"
      ? records.find((doc) => doc.id === selectedId) || null
      : records.find((run) => run.id === selectedId) || null;

  const tabs = `
    <div class="source-cats" role="tablist" aria-label="Source categories">
      <button type="button" role="tab" id="source-cat-datasets" aria-selected="${category === "datasets"}" class="source-cat ${category === "datasets" ? "is-on" : ""}" data-explorer-cat="datasets">Datasets <span class="source-cat-count">${counts.datasets}</span></button>
      <button type="button" role="tab" id="source-cat-snapshots" aria-selected="${category === "snapshots"}" class="source-cat ${category === "snapshots" ? "is-on" : ""}" data-explorer-cat="snapshots">Saved snapshots <span class="source-cat-count">${counts.snapshots}</span></button>
      <button type="button" role="tab" id="source-cat-documents" aria-selected="${category === "documents"}" class="source-cat ${category === "documents" ? "is-on" : ""}" data-explorer-cat="documents">Reference documents <span class="source-cat-count">${counts.documents}</span></button>
    </div>`;

  const docFilters =
    category === "documents"
      ? `<div class="source-doc-filters" role="group" aria-label="Document type">
          <button type="button" class="source-filter ${state.sourceExplorer.docFilter === "all" ? "is-on" : ""}" data-explorer-doc-filter="all">All</button>
          <button type="button" class="source-filter ${state.sourceExplorer.docFilter === "procedures" ? "is-on" : ""}" data-explorer-doc-filter="procedures">Procedures</button>
          <button type="button" class="source-filter ${state.sourceExplorer.docFilter === "incidents" ? "is-on" : ""}" data-explorer-doc-filter="incidents">Prior incidents</button>
        </div>`
      : "";

  let listHtml = "";
  if (!records.length) {
    listHtml =
      category === "datasets"
        ? `<p class="trust-empty">No datasets in the catalog yet. Refresh the dataset catalog under Data maintenance.</p>`
        : category === "snapshots"
          ? `<p class="trust-empty">No saved snapshots yet. Opening a case saves a telemetry window here.</p>`
          : `<p class="trust-empty">No reference documents indexed. Rebuild the document search index under Data maintenance.</p>`;
  } else if (category === "datasets") {
    listHtml = `<div class="source-list-head source-list-head-datasets" aria-hidden="true"><span>Name</span><span>Range</span><span>Time steps</span></div>
      ${records
        .map((run) => {
          const copy = tapeCopy(run);
          const on = run.id === selectedId ? "is-on" : "";
          return `<button type="button" class="source-row source-row-dataset ${on}" data-explorer-select="${escapeHtml(run.id)}" aria-pressed="${run.id === selectedId}">
            <span class="source-row-main">
              <strong>${escapeHtml(copy.title)}</strong>
              <code class="source-row-id">${escapeHtml(run.id)}</code>
            </span>
            <span class="source-row-meta">${escapeHtml(formatMissionSpan(run.clock_start, run.clock_end))}</span>
            <span class="source-row-count">${run.samples != null ? Number(run.samples).toLocaleString() : "—"}</span>
          </button>`;
        })
        .join("")}`;
  } else if (category === "snapshots") {
    listHtml = `<div class="source-list-head source-list-head-snapshots" aria-hidden="true"><span>Source</span><span>Saved window</span><span>Values</span></div>
      ${records
        .map((run) => {
          const copy = tapeCopy(run);
          const on = run.id === selectedId ? "is-on" : "";
          const linked = incidentsForRun(run.id);
          return `<button type="button" class="source-row source-row-snapshot ${on}" data-explorer-select="${escapeHtml(run.id)}" aria-pressed="${run.id === selectedId}">
            <span class="source-row-main">
              <strong>${escapeHtml(copy.title)}</strong>
              <code class="source-row-id">${escapeHtml(run.id)}</code>
              ${linked.length ? `<span class="source-row-link">${escapeHtml(linked.map((i) => i.id).join(", "))}</span>` : `<span class="source-row-link is-muted">No linked case recorded</span>`}
            </span>
            <span class="source-row-meta">${escapeHtml(formatMissionSpan(run.clock_start, run.clock_end))}</span>
            <span class="source-row-count" title="Channel values stored for this snapshot">${run.samples != null ? Number(run.samples).toLocaleString() : "—"}</span>
          </button>`;
        })
        .join("")}`;
  } else {
    listHtml = records
      .map((doc) => {
        const on = doc.id === selectedId ? "is-on" : "";
        const origin = documentOriginLabel(doc);
        const desc = documentShortDescription(doc);
        const typeLabel = doc.kind === "procedure" ? "Procedure" : "Prior incident";
        return `<button type="button" class="source-row source-row-doc kind-${escapeHtml(doc.kind || "doc")} ${on}" data-explorer-select="${escapeHtml(doc.id)}" aria-pressed="${doc.id === selectedId}">
          <span class="source-row-main">
            <span class="source-row-type">${escapeHtml(typeLabel)}</span>
            <strong>${escapeHtml(doc.title || doc.id)}</strong>
            <code class="source-row-id">${escapeHtml(doc.id)}</code>
            ${desc ? `<span class="source-row-desc">${escapeHtml(desc)}</span>` : ""}
            ${origin ? `<span class="source-row-origin">${escapeHtml(origin)}</span>` : ""}
          </span>
        </button>`;
      })
      .join("");
  }

  let detailHtml = "";
  if (!selected) {
    detailHtml = `<div class="source-detail-empty"><p>Select a source to inspect its contents and metadata.</p></div>`;
  } else if (category === "datasets") {
    detailHtml = renderExplorerDatasetDetail(selected);
  } else if (category === "snapshots") {
    detailHtml = renderExplorerSnapshotDetail(selected);
  } else {
    detailHtml = renderExplorerDocumentDetail(selected);
  }

  root.innerHTML = `
    ${tabs}
    <p class="source-intro">${escapeHtml(intro)}</p>
    ${docFilters}
    <div class="source-browser ${detailOpen && selected ? "is-detail-open" : ""}">
      <div class="source-list" id="source-explorer-list" role="listbox" aria-label="${escapeHtml(category)}">${listHtml}</div>
      <aside class="source-detail ${category === "documents" ? "is-docs" : category === "snapshots" ? "is-snap" : "is-data"}" id="source-explorer-detail" aria-live="polite">
        <button type="button" class="source-detail-back text-btn" data-explorer-detail-back ${detailOpen && selected ? "" : "hidden"}>Back to list</button>
        ${detailHtml}
      </aside>
    </div>`;

  restoreExplorerListScroll();
  renderMaintenance();
}

function renderConnectors() {
  renderSourceExplorer();
}

function releaseVerdictTone(rec) {
  if (rec === "PASS") return "pass";
  if (rec === "BLOCKED") return "blocked";
  return "insufficient";
}

const EVAL_METRIC_COPY = {
  diagnosis: {
    title: "Names the fault",
    gloss: "When something broke, the report said what.",
  },
  withhold: {
    title: "Holds when unsure",
    gloss: "Thin evidence. It does not invent a cause.",
  },
  false_inhibit: {
    title: "Leaves a healthy heater",
    gloss: "Never recommends shutting one down that isn’t the fault.",
  },
  provenance: {
    title: "Stamps every claim",
    gloss: "Observed, derived, documented, hypothesis — on the sentence.",
  },
};

const EVAL_CASE_COPY = {
  eps204: {
    n: "01",
    title: "Science was on. The heater still failed.",
    note: "Don’t blame the payload.",
  },
  fault1: {
    n: "02",
    title: "Payload was idle. The heater still failed.",
    note: "The heater is the load.",
  },
  pay002: {
    n: "03",
    title: "Heater was already off. The payload failed.",
    note: "Don’t shut a heater that isn’t running.",
  },
  batt003: {
    n: "04",
    title: "Currents were healthy. The pack sagged.",
    note: "Leave the heater alone.",
  },
  marg001: {
    n: "05",
    title: "It looked like a heater. The report held.",
    note: "Thin evidence. Don’t invent a cause.",
  },
};

const EVAL_CHECK_COPY = {
  tagged_claims: { title: "Stamps every claim", gloss: "Observed, derived, documented, hypothesis." },
  provenance_roles: { title: "Facts stay facts", gloss: "Timeline is observed. The cause is a hypothesis." },
  cites_heater_current: { title: "Cites the heater", gloss: "Current at the warn is in the report." },
  heater_is_suspect: { title: "Names the heater", gloss: "The heater is the suspect." },
  recommends_inhibit_heater: { title: "Says inhibit the heater", gloss: "Recommend it. Do not send it." },
  does_not_close_on_payload: { title: "Doesn’t blame the payload", gloss: "Science mode is not the cause." },
  cites_payload_current: { title: "Cites the payload", gloss: "Current at the warn is in the report." },
  payload_is_suspect: { title: "Names the payload", gloss: "The payload is the suspect." },
  recommends_safe_payload: { title: "Says safe the payload", gloss: "Recommend it. Do not send it." },
  cites_battery_voltage: { title: "Cites the pack", gloss: "Voltage at the warn is in the report." },
  does_not_safe_payload: { title: "Leaves the payload alone", gloss: "Does not recommend safing it." },
  does_not_inhibit_heater: { title: "Leaves the heater alone", gloss: "Does not recommend shutting it down." },
  stops_without_commanding: { title: "Stops at a human", gloss: "No uplink language." },
  cites_procedure: { title: "Cites the procedure", gloss: "The book is in the report." },
  cites_similar_incident: { title: "Cites a prior", gloss: "A similar close is in the report." },
  cites_warn_clock: { title: "Cites the warn time", gloss: "The crossing clock is in the report." },
  no_hypothesis_section: { title: "No invented cause", gloss: "Does not write a hypothesis close." },
  no_root_cause_asserted: { title: "Does not name a fault", gloss: "No FAULT id as confirmed cause." },
  no_prime_suspect: { title: "Does not pick a culprit", gloss: "Evidence is too thin to name one." },
  cites_marginal_ratio: { title: "Cites the thin ratio", gloss: "Heater current is below the inhibit bar." },
  states_threshold: { title: "States the threshold", gloss: "Names the ≥2× overcurrent bar." },
  names_confounder: { title: "Names the decoy", gloss: "Science mode is named, not treated as proof." },
  rules_out_similar: { title: "Rules out the prior", gloss: "The similar close is a non-match." },
  lists_next_checks: { title: "Lists what to check next", gloss: "Follow-ups instead of a forced close." },
  recommends_hold: { title: "Recommends hold", gloss: "No inhibit. No safing. No FAULT id." },
};

function evalCheckCopy(id, fallback) {
  return EVAL_CHECK_COPY[id] || { title: fallback || id, gloss: "" };
}

function evalMetricCopy(id, fallback) {
  return EVAL_METRIC_COPY[id] || { title: fallback || id, gloss: "" };
}

function evalCaseCopy(id, fallbackLabel) {
  return EVAL_CASE_COPY[id] || { title: fallbackLabel || id, note: id };
}

function metricShortLabel(id, fallback) {
  return evalMetricCopy(id, fallback).title;
}

function buildScorecardHtml(trust, cmp, explorer, loading) {
  const sc = trust?.eval?.scorecard;
  const cmpData = cmp || {};
  const ex = explorer || {};
  const rec = cmpData.recommendation ?? ex.recommendation;
  const hasBaseline = Boolean(cmpData.baseline?.baseline_id || cmpData.baseline?.run_id);
  const hasCompare = Boolean(rec);
  const releaseTone = rec ? releaseVerdictTone(rec) : null;
  const baselineRunId = cmpData.baseline?.run_id;
  const candidateRunId = cmpData.candidate?.run_id || ex.run?.run_id;
  const isBenchmark = Boolean(
    hasBaseline && baselineRunId && candidateRunId && baselineRunId === candidateRunId
  );

  let verdictLabel = "—";
  let headline = "No benchmark yet";
  if (loading && !sc) {
    verdictLabel = "…";
    headline = "Reading the eval";
  } else if (rec === "BLOCKED" || (sc && !sc.ok && rec !== "PASS")) {
    verdictLabel = "Blocked";
    headline = "Fails the benchmark";
  } else if (rec === "INSUFFICIENT_COVERAGE" || (!hasBaseline && !rec && !sc?.ok)) {
    verdictLabel = "No benchmark";
    headline = "No benchmark yet";
  } else if (isBenchmark) {
    verdictLabel = "Benchmark";
    headline = "This run is the benchmark";
  } else if (rec === "PASS" || sc?.ok) {
    verdictLabel = "Pass";
    headline = "Clears the benchmark";
  }
  const verdictTone =
    rec === "BLOCKED" || (sc && !sc.ok) ? "blocked" : rec === "INSUFFICIENT_COVERAGE" || (!hasBaseline && !rec) ? "pending" : "pass";
  const lede = isBenchmark
    ? "Later evals have to match this. Name the fault, hold when unsure, leave a healthy heater, stamp every claim."
    : hasBaseline
      ? "This run against the benchmark. Name the fault, hold when unsure, leave a healthy heater, stamp every claim."
      : "Five scenarios. Pass them, then make this the benchmark.";

  if (loading && !sc) {
    return `<article class="panel trust-eval is-loading" id="trust-scorecard">
      <div class="eval-mast">
        <div class="eval-mast-row">
          <p class="panel-kicker">Eval</p>
          <span class="chip chip-ready">${escapeHtml(verdictLabel)}</span>
        </div>
        <h2>${headline}</h2>
        <p class="hint">Loading the suite…</p>
      </div>
    </article>`;
  }

  const scoreRates = sc
    ? [sc.diagnosis, sc.withhold, sc.false_inhibit, sc.provenance].filter(Boolean)
    : [];
  const cmpMetrics = cmpData.metrics || [];
  const metricById = Object.fromEntries(cmpMetrics.map((m) => [m.id, m]));
  const rateSource = scoreRates.length
    ? scoreRates.map((r) => {
        const cm = metricById[r.id];
        return {
          id: r.id,
          label: r.label,
          display: r.display || `${r.passed}/${r.total}`,
          ok: r.passed === r.total,
          delta: cm?.delta,
          baseline: cm && cm.baseline_passed != null ? `${cm.baseline_passed}/${cm.baseline_total}` : null,
        };
      })
    : cmpMetrics.map((m) => ({
        id: m.id,
        label: m.label,
        display: `${m.candidate_passed}/${m.candidate_total}`,
        ok: m.candidate_passed === m.candidate_total,
        delta: m.delta,
        baseline: m.baseline_passed != null ? `${m.baseline_passed}/${m.baseline_total}` : null,
      }));

  const metricHtml = rateSource.length
    ? `<div class="eval-rates">${rateSource
        .map((r) => {
          const copy = evalMetricCopy(r.id, r.label);
          const tone = r.delta < 0 ? "is-regressed" : r.delta > 0 ? "is-improved" : r.ok ? "is-ok" : "is-fail";
          const ref =
            r.baseline && r.delta
              ? `<span class="eval-rate-ref">${r.delta > 0 ? "Up" : "Down"} from ${escapeHtml(r.baseline)} on the benchmark</span>`
              : "";
          return `<div class="eval-rate ${tone}">
            <p class="eval-rate-n">${escapeHtml(r.display)}</p>
            <p class="eval-rate-title">${escapeHtml(copy.title)}</p>
            <p class="eval-rate-gloss">${escapeHtml(copy.gloss)}</p>
            ${ref}
          </div>`;
        })
        .join("")}</div>`
    : "";

  const compareLane =
    !hasBaseline && hasCompare && rec === "INSUFFICIENT_COVERAGE"
      ? `<p class="hint eval-baseline-note">No benchmark yet. Pass the suite, then make this the benchmark.</p>`
      : loading && !hasBaseline
        ? `<p class="hint eval-baseline-note">Checking for a benchmark…</p>`
        : "";

  const explorerCases = ex.cases?.length ? ex.cases : null;
  const cmpCaseRows = cmpData.cases?.rows?.length ? cmpData.cases.rows : null;
  const scCaseRows = sc?.cases?.length ? sc.cases : null;

  const caseRows = explorerCases
    ? explorerCases.map((row) => ({
        id: row.id,
        label: row.label,
        candidate_ok: row.ok,
        passed: row.passed,
        total: row.total,
        critical_failure: row.critical_failure,
      }))
    : cmpCaseRows
      ? cmpCaseRows
      : (scCaseRows || []).map((row) => ({
          id: row.id,
          label: row.label,
          candidate_ok: row.ok,
          passed: row.passed,
          total: row.total,
          critical_failure: false,
        }));

  const caseTable =
    caseRows.length > 0
      ? `<div class="eval-flights">
          ${caseRows
            .map((row, i) => {
              const mark = row.candidate_ok ? "pass" : "fail";
              const copy = evalCaseCopy(row.id, row.label);
              const n = copy.n || String(i + 1).padStart(2, "0");
              const critical = row.critical_failure ? `<span class="eval-flight-crit">Critical</span>` : "";
              return `<button type="button" class="eval-flight is-${mark}" data-release-case="${escapeHtml(row.id)}">
                <span class="eval-flight-n">${escapeHtml(n)}</span>
                <span class="eval-flight-copy">
                  <strong>${escapeHtml(copy.title)}</strong>
                  <span>${escapeHtml(copy.note)}</span>
                </span>
                ${critical}
                <span class="chip ${mark === "pass" ? "chip-filed" : "chip-crit"}">${mark === "pass" ? "Pass" : "Fail"}</span>
              </button>`;
            })
            .join("")}
        </div>`
      : "";

  const blockers = cmpData.blockers || [];
  const warnings = cmpData.warnings || [];
  const coverage = cmpData.coverage_issues || [];
  let calloutHtml = "";
  if (cmpData.error) {
    calloutHtml = `<div class="eval-callout is-error"><strong>Comparison unavailable</strong><p>${escapeHtml(cmpData.error)}</p></div>`;
  } else if (rec === "BLOCKED" && blockers.length) {
    calloutHtml = `<div class="eval-callout is-blocked"><strong>A safety check failed</strong><ul>${blockers
      .map((b) => {
        const flight = evalCaseCopy(b.case_id, b.case_id);
        return `<li>${escapeHtml(flight.title)} — ${escapeHtml(b.detail || b.check_id || "")}</li>`;
      })
      .join("")}</ul></div>`;
  } else if (rec === "INSUFFICIENT_COVERAGE" && coverage.length) {
    calloutHtml = `<div class="eval-callout is-insufficient"><strong>The suite is too thin</strong><ul>${coverage
      .map((issue) => `<li>${escapeHtml(issue)}</li>`)
      .join("")}</ul></div>`;
  } else if (warnings.length) {
    calloutHtml = `<div class="eval-callout is-warn"><strong>Warnings</strong><ul>${warnings
      .map((w) => `<li>${escapeHtml(w.message || "")}</li>`)
      .join("")}</ul></div>`;
  }

  const thisRunLine = ex.run
    ? `${ex.run.provider || sc?.provider || "rules"} · ${formatSyncAt(ex.run.generated_at || sc?.generated_at)}`
    : sc
      ? `${sc.provider || "rules"} · ${formatSyncAt(sc.generated_at)}`
      : loading
        ? "Loading…"
        : "—";
  const benchmarkLine = hasBaseline
    ? isBenchmark
      ? "This run"
      : `${cmpData.baseline?.agent?.provider || "rules"} · ${formatSyncAt(cmpData.baseline?.approved_at || cmpData.baseline?.generated_at)}`
    : "None yet";

  const canPromote = rec === "PASS" && !isBenchmark;
  const benchAct = canPromote
    ? `<button type="button" class="btn-bar" data-promote-baseline>Make this the benchmark</button>`
    : isBenchmark
      ? `<span class="eval-bench-now">Current benchmark</span>`
      : rec === "PASS" && !hasBaseline
        ? `<button type="button" class="btn-bar" data-promote-baseline>Make this the benchmark</button>`
        : "";

  const foot = `<div class="eval-bench">
    <div class="eval-bench-side">
      <span class="k">This run</span>
      <span class="v">${escapeHtml(thisRunLine)}</span>
    </div>
    <span class="eval-bench-vs">vs</span>
    <div class="eval-bench-side${isBenchmark ? " is-current" : ""}">
      <span class="k">Benchmark</span>
      <span class="v">${escapeHtml(benchmarkLine)}</span>
    </div>
    ${benchAct ? `<div class="eval-bench-act">${benchAct}</div>` : ""}
  </div>`;

  const scoreBody = sc || rateSource.length
    ? `${metricHtml}
      ${calloutHtml}
      ${compareLane}
      ${caseTable}
      ${foot}`
    : `${compareLane}
      ${calloutHtml}
      <p class="hint">No harness results yet.</p>`;

  const releaseClass = releaseTone ? ` release-${releaseTone}` : "";
  const chipCls = verdictTone === "pass" ? "chip-filed" : verdictTone === "blocked" ? "chip-crit" : "chip-ready";
  return `<article class="panel trust-eval ${releaseClass}" id="trust-scorecard">
    <div class="eval-mast">
      <div class="eval-mast-row">
        <p class="panel-kicker">Eval</p>
        <span class="chip ${chipCls}">${escapeHtml(verdictLabel)}</span>
      </div>
      <h2>${headline}</h2>
      <p class="hint">${lede}</p>
    </div>
    ${scoreBody}
  </article>`;
}

function renderTrust() {
  if (state.trustSub === "releaseCase") {
    _syncTrustPanels();
    return;
  }

  const t = state.trust;
  const head = $("trust-head");
  if (!head) return;

  if (state.trustLoading && !t) {
    head.innerHTML = `<h1>Can I trust this?</h1><p class="trust-head-lede">Checking sources…</p>`;
    const slot = $("trust-scorecard-slot");
    if (slot) {
      slot.innerHTML = buildScorecardHtml(null, state.releaseCompare, state.evalExplorer, true);
    }
    renderSourceExplorer();
    _syncTrustPanels();
    return;
  }
  if (!t) {
    head.innerHTML = `<h1>Can I trust this?</h1><p class="trust-head-lede">Could not load store status. Is Postgres running?</p>`;
    const slot = $("trust-scorecard-slot");
    if (slot) slot.innerHTML = buildScorecardHtml(null, state.releaseCompare, state.evalExplorer, false);
    renderSourceExplorer();
    _syncTrustPanels();
    return;
  }

  const storeTone = trustTone(t.store?.linked);
  const libraryTone = trustTone(t.library?.ready, t.library?.documents > 0 && !t.library?.ready);
  const archiveLabel = t.store?.linked ? "Archive linked" : "Archive unlinked";
  const libraryLabel = t.library?.ready ? "Library ready" : "Library not ready";
  const investigatorLabel = `Investigator: ${t.investigator?.provider_ui || "rules"}`;

  head.innerHTML = `
    <h1>Can I trust this?</h1>
    <p class="trust-head-lede">Sealed window. Tagged claims. Human decision. Not the archive of record, not the uplink.</p>
    <div class="trust-summary">
      <span class="trust-pill is-${storeTone}"><span class="dot"></span>${escapeHtml(archiveLabel)}</span>
      <span class="trust-pill is-${libraryTone}"><span class="dot"></span>${escapeHtml(libraryLabel)}</span>
      <span class="trust-pill is-ok"><span class="dot"></span>${escapeHtml(investigatorLabel)}</span>
      <span class="trust-pill is-ok"><span class="dot"></span>${escapeHtml(t.mission || "Aurora-1")}</span>
    </div>`;

  const slot = $("trust-scorecard-slot");
  if (slot) {
    slot.innerHTML = buildScorecardHtml(t, state.releaseCompare, state.evalExplorer, false);
  }

  renderSourceExplorer();
  _syncTrustPanels();
}

function _syncTrustPanels() {
  const releaseCase = state.trustSub === "releaseCase";
  const overview = state.trustSub === "overview";
  $("trust-score-panel")?.toggleAttribute("hidden", !overview);
  $("trust-release-case-panel")?.toggleAttribute("hidden", !releaseCase);
  $("trust-head")?.toggleAttribute("hidden", releaseCase);
  $("trust-sources-panel")?.toggleAttribute("hidden", !overview);
}

async function loadReleaseCase(caseId) {
  state.releaseLoading = true;
  state.releaseCaseId = caseId;
  renderReleaseCase();
  try {
    const res = await fetch(apiUrl(`/eval/cases/${encodeURIComponent(caseId)}`));
    if (!res.ok) throw new Error(`case ${res.status}`);
    state.releaseCase = await res.json();
  } catch (err) {
    state.releaseCase = { error: err.message, id: caseId };
  } finally {
    state.releaseLoading = false;
    renderReleaseCase();
  }
}

function highlightProvenanceTags(text) {
  const escaped = escapeHtml(text || "");
  return escaped.replace(/\[(OBSERVED|DERIVED|DOCUMENTED|HYPOTHESIS)\]/gi, (_, tag) => {
    const upper = tag.toUpperCase();
    return `<span class="provenance-tag is-${upper}">[${upper}]</span>`;
  });
}

function formatEvalInline(escaped) {
  return escaped
    .replace(
      /\[(OBSERVED|DERIVED|DOCUMENTED|HYPOTHESIS)\]/gi,
      (_, tag) => {
        const upper = tag.toUpperCase();
        return `<span class="provenance-tag is-${upper}">[${upper}]</span>`;
      }
    )
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function formatEvalDocument(text) {
  const raw = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!raw) return "";
  const lines = escapeHtml(raw).split("\n");
  const out = [];
  let list = null;
  const closeList = () => {
    if (!list) return;
    out.push(list === "ul" ? "</ul>" : "</ol>");
    list = null;
  };
  const openList = (kind) => {
    if (list === kind) return;
    closeList();
    out.push(kind === "ul" ? "<ul>" : "<ol>");
    list = kind;
  };

  for (const line of lines) {
    const heading = line.match(/^#{1,2}\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (heading) {
      closeList();
      const level = line.startsWith("##") ? "h4" : "h3";
      out.push(`<${level}>${formatEvalInline(heading[1])}</${level}>`);
    } else if (bullet) {
      openList("ul");
      out.push(`<li>${formatEvalInline(bullet[1])}</li>`);
    } else if (numbered) {
      openList("ol");
      out.push(`<li>${formatEvalInline(numbered[1])}</li>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${formatEvalInline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

function buildEvalCheckStackHtml(checksEnriched) {
  if (!checksEnriched?.length) return `<p class="eval-block-lede">No checks on this run.</p>`;
  return `<div class="eval-flights">${checksEnriched
    .map((c, i) => {
      const mark = c.passed ? "pass" : "fail";
      const copy = evalCheckCopy(c.id, c.label);
      const n = String(i + 1).padStart(2, "0");
      const critical = c.critical ? `<span class="eval-flight-crit">Critical</span>` : "";
      const result = c.detail ? `<p>${escapeHtml(c.detail)}</p>` : "";
      return `<details class="eval-flight is-${mark}${c.critical ? " is-critical" : ""}">
        <summary>
          <span class="eval-flight-n">${n}</span>
          <span class="eval-flight-copy">
            <strong>${escapeHtml(copy.title)}</strong>
            <span>${escapeHtml(copy.gloss)}</span>
          </span>
          ${critical}
          <span class="chip ${mark === "pass" ? "chip-filed" : "chip-crit"}">${mark === "pass" ? "Pass" : "Fail"}</span>
        </summary>
        ${result ? `<div class="eval-flight-body">${result}</div>` : ""}
      </details>`;
    })
    .join("")}</div>`;
}

function buildEvalPageHtml(caseId, cand, data, loading) {
  const contract = cand?.contract || {};
  const copy = evalCaseCopy(caseId, contract.label || (loading ? "Loading" : "Eval"));
  const observed = cand?.observed || {};
  const ok = cand?.ok;
  const hasCritical = (data?.critical_failures || []).length > 0;
  const chipCls = loading ? "chip-ready" : ok === true ? "chip-filed" : ok === false ? "chip-crit" : "chip-ready";
  const chipLabel = loading ? "…" : ok === true ? "Pass" : ok === false ? "Fail" : "—";
  const releaseClass = ok === false || hasCritical ? "release-blocked" : ok === true ? "release-pass" : loading ? "release-insufficient" : "";
  const kicker = copy.n ? `Eval · ${copy.n}` : "Eval";

  const rates = loading
    ? ""
    : `<div class="eval-rates">
        <div class="eval-rate">
          <p class="eval-rate-n">${escapeHtml(observed.warn_clock || "—")}</p>
          <p class="eval-rate-title">Warn</p>
          <p class="eval-rate-gloss">First crossing on the sealed window.</p>
        </div>
        <div class="eval-rate">
          <p class="eval-rate-n">${observed.heater_a != null ? escapeHtml(fmt(observed.heater_a, 2)) : "—"}</p>
          <p class="eval-rate-title">Heater</p>
          <p class="eval-rate-gloss">Amps at the warn.</p>
        </div>
        <div class="eval-rate">
          <p class="eval-rate-n">${observed.payload_a != null ? escapeHtml(fmt(observed.payload_a, 2)) : "—"}</p>
          <p class="eval-rate-title">Payload</p>
          <p class="eval-rate-gloss">Amps at the warn.</p>
        </div>
        <div class="eval-rate">
          <p class="eval-rate-n">${observed.has_science ? "On" : "Off"}</p>
          <p class="eval-rate-title">Science</p>
          <p class="eval-rate-gloss">Mode at the warn.</p>
        </div>
      </div>`;

  if (loading) {
    return `<p class="case-back"><button type="button" class="text-btn" data-trust-back>Eval</button></p>
    <article class="panel trust-eval eval-page is-loading ${releaseClass}">
      <div class="eval-mast">
        <div class="eval-mast-row">
          <p class="panel-kicker">${escapeHtml(kicker)}</p>
          <span class="chip ${chipCls}">${chipLabel}</span>
        </div>
        <h1>${escapeHtml(copy.title)}</h1>
        <p class="hint">Reading this scenario…</p>
      </div>
    </article>`;
  }

  if (data?.error) {
    return `<p class="case-back"><button type="button" class="text-btn" data-trust-back>Eval</button></p>
    <article class="panel trust-eval eval-page release-blocked">
      <div class="eval-mast">
        <div class="eval-mast-row">
          <p class="panel-kicker">${escapeHtml(kicker)}</p>
          <span class="chip chip-crit">Fail</span>
        </div>
        <h1>${escapeHtml(copy.title)}</h1>
        <p class="hint">${escapeHtml(data.error)}</p>
      </div>
    </article>`;
  }

  const checks = data?.checks_enriched?.length ? data.checks_enriched : (cand?.checks || []).map((c) => ({ ...c, label: c.id }));
  const passed = cand?.passed;
  const total = cand?.total;
  const checkCount =
    passed != null && total != null
      ? `<span class="eval-block-count">${escapeHtml(String(passed))}/${escapeHtml(String(total))}</span>`
      : "";

  const report = cand?.report
    ? `<section class="eval-block">
        <header class="eval-block-head">
          <h2>The report</h2>
        </header>
        <div class="eval-doc">${formatEvalDocument(cand.report)}</div>
      </section>`
    : "";

  const checksBlock = `<section class="eval-block">
      <header class="eval-block-head">
        <h2>Checks</h2>
        ${checkCount}
      </header>
      ${buildEvalCheckStackHtml(checks)}
    </section>`;

  const hold = cand?.withhold_explanation
    ? `<section class="eval-block">
        <header class="eval-block-head">
          <h2>Hold</h2>
        </header>
        <div class="eval-doc">${formatEvalDocument(cand.withhold_explanation)}</div>
      </section>`
    : "";

  const comparison = data?.comparison;
  const benchStatus = comparison
    ? comparison.status === "unchanged"
      ? "Unchanged"
      : comparison.status === "regressed"
        ? "Regressed"
        : comparison.status === "improved"
          ? "Improved"
          : comparison.status || "—"
    : data?.baseline_available
      ? "—"
      : "No benchmark";
  const regress =
    comparison?.check_regressions?.length
      ? ` · ${comparison.check_regressions.length} check${comparison.check_regressions.length === 1 ? "" : "s"} down`
      : "";
  const foot = `<div class="eval-bench">
      <div class="eval-bench-side">
        <span class="k">This scenario</span>
        <span class="v">${passed != null && total != null ? `${escapeHtml(String(passed))} / ${escapeHtml(String(total))} checks` : "—"}</span>
      </div>
      <span class="eval-bench-vs">vs</span>
      <div class="eval-bench-side${comparison?.status === "unchanged" || ok ? " is-current" : ""}">
        <span class="k">Benchmark</span>
        <span class="v">${escapeHtml(benchStatus)}${escapeHtml(regress)}</span>
      </div>
    </div>`;

  return `<p class="case-back"><button type="button" class="text-btn" data-trust-back>Eval</button></p>
  <article class="panel trust-eval eval-page ${releaseClass}">
    <div class="eval-mast">
      <div class="eval-mast-row">
        <p class="panel-kicker">${escapeHtml(kicker)}</p>
        <span class="chip ${chipCls}">${chipLabel}</span>
        ${hasCritical ? `<span class="chip chip-crit">Critical</span>` : ""}
      </div>
      <h1>${escapeHtml(copy.title)}</h1>
      ${copy.note ? `<p class="hint">${escapeHtml(copy.note)}</p>` : ""}
    </div>
    ${rates}
    ${report}
    ${checksBlock}
    ${hold}
    ${foot}
  </article>`;
}

function renderReleaseCase() {
  const slot = $("trust-release-case-slot");
  if (!slot) return;
  _syncTrustPanels();

  const caseId = state.releaseCaseId || "—";

  if (state.releaseLoading) {
    slot.innerHTML = buildEvalPageHtml(caseId, null, null, true);
    return;
  }

  const data = state.releaseCase;
  if (!data || data.error) {
    slot.innerHTML = buildEvalPageHtml(caseId, null, data, false);
    return;
  }

  slot.innerHTML = buildEvalPageHtml(caseId, data.candidate || {}, data, false);
}

function enterTrustOverview() {
  state.trustSub = "overview";
  state.releaseCaseId = null;
  setView("trust");
  if (!state.trust) loadTrust();
  else renderTrust();
  $("stage").scrollTop = 0;
  syncUrl("trust");
}

function enterTrustReleaseCase(caseId) {
  state.trustSub = "releaseCase";
  state.releaseCaseId = caseId;
  setView("trust");
  _syncTrustPanels();
  loadReleaseCase(caseId);
  $("stage").scrollTop = 0;
  syncUrl("trust");
}

async function promoteBaseline() {
  if (!window.confirm("Make this run the benchmark? Later evals will be scored against it.")) return;
  try {
    const res = await fetch(apiUrl("/eval/baseline/promote"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "promoted from Trust release view" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `promote ${res.status}`);
    }
    await loadTrust();
    window.alert("This run is now the benchmark.");
  } catch (err) {
    window.alert(err.message);
  }
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
    eventsRoot.innerHTML = `<p class="trust-empty">${escapeHtml(data.error)}</p>`;
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
      `<span class="inspector-window-line is-muted">${Number(ins.savedChannelValues).toLocaleString()} channel values in the saved package</span>`
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
  document.body.classList.toggle("view-trust", view === "trust");
  $("tab-home")?.classList.toggle("is-on", view === "home");
  $("tab-incidents")?.classList.toggle("is-on", view === "incidents");
  $("tab-trust")?.classList.toggle("is-on", view === "trust");
  const skip = $("skip");
  if (skip) {
    skip.href =
      view === "incidents"
        ? "#incidents-desk"
        : view === "case"
          ? "#stage"
          : view === "trust"
            ? "#trust-desk"
            : "#home";
    skip.textContent =
      view === "incidents"
        ? "Skip to incidents"
        : view === "case"
          ? "Skip to case"
          : view === "trust"
            ? "Skip to trust"
            : "Skip to overview";
  }
}

/** Avoid pushState while applying browser back/forward or boot pathname. */
let syncingFromHistory = false;

function pathForView(view, incidentId = state.incidentId) {
  if (view === "incidents") return appPath("/incidents");
  if (view === "trust") {
    if (state.trustSub === "releaseCase" && state.releaseCaseId) {
      return appPath(`/trust/cases/${encodeURIComponent(state.releaseCaseId)}`);
    }
    return appPath("/trust");
  }
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
    { view, incidentId, trustSub: state.trustSub, releaseCaseId: state.releaseCaseId },
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
  if (path === "/incidents") return { view: "incidents", incidentId: null, trustSub: "overview", releaseCaseId: null };
  const releaseCaseMatch = path.match(/^\/trust\/(?:release\/)?cases\/([^/]+)$/);
  if (releaseCaseMatch) {
    return {
      view: "trust",
      incidentId: null,
      trustSub: "releaseCase",
      releaseCaseId: decodeURIComponent(releaseCaseMatch[1]),
    };
  }
  if (path === "/trust/release" || path === "/trust/release/") {
    return { view: "trust", incidentId: null, trustSub: "overview", releaseCaseId: null };
  }
  if (path === "/trust") return { view: "trust", incidentId: null, trustSub: "overview", releaseCaseId: null };
  return { view: "home", incidentId: null, trustSub: "overview", releaseCaseId: null };
}

async function routeFromPath(pathname, { replace = false } = {}) {
  const { view, incidentId, trustSub, releaseCaseId } = parsePath(pathname);
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
    } else if (view === "trust") {
      if (trustSub === "releaseCase" && releaseCaseId) {
        enterTrustReleaseCase(releaseCaseId);
      } else {
        enterTrustOverview();
      }
    } else {
      enterHome();
    }
    const path = pathForView(state.view, state.incidentId);
    history.replaceState(
      {
        view: state.view,
        incidentId: state.view === "case" ? state.incidentId : null,
        trustSub: state.trustSub,
        releaseCaseId: state.releaseCaseId,
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
  updateReadouts();
  $("stage").scrollTop = 0;
  syncUrl("home");
}

function enterIncidents() {
  setView("incidents");
  renderIncidents();
  updateReadouts();
  $("stage").scrollTop = 0;
  syncUrl("incidents");
}

function enterCase() {
  setView("case");
  renderIncidents();
  syncUrl("case");
}

function enterTrust() {
  enterTrustOverview();
}

async function goTrust() {
  enterTrust();
}

function syncFold(id, open, toggleId, stateLabelId) {
  const bundle = $(id);
  const toggle = $(toggleId);
  const stateLabel = $(stateLabelId);
  if (!bundle) return;
  if (bundle.classList.contains("is-pinned")) {
    bundle.classList.remove("is-collapsed");
    return;
  }
  bundle.classList.toggle("is-collapsed", !open);
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (stateLabel) stateLabel.textContent = open ? "Hide" : "Show";
}

function syncEvidenceBundle() {
  state.evidenceOpen = true;
  syncFold("evidence", true, "evidence-toggle", "evidence-toggle-state");
}

function syncProcedureBundle() {
  syncFold("procedure", state.procedureOpen, "procedure-toggle", "procedure-toggle-state");
}

function syncKnowledgeBundle() {
  syncFold("knowledge", state.knowledgeOpen, "knowledge-toggle", "knowledge-toggle-state");
}

function syncCaseFolds() {
  syncEvidenceBundle();
  syncProcedureBundle();
  syncKnowledgeBundle();
}

function investigationFailed() {
  return Boolean(state.report) && /^#\s*Could not investigate/i.test(String(state.report).trim());
}

function hasSuccessfulInvestigation() {
  if (state.investigating) return false;
  if (state.incident?.status === "filed") return true;
  if (!state.report || investigationFailed()) return false;
  return true;
}

function updateInvestigationChrome() {
  const hasReport = hasSuccessfulInvestigation();
  const filed = state.incident?.status === "filed";
  document.body.classList.toggle("has-investigation", hasReport);
  document.body.classList.toggle("is-investigating", state.investigating);
  const hero = $("investigation");
  if (hero) hero.classList.toggle("has-report", hasReport && !state.investigating);
  const heading = $("investigation-heading");
  const hint = $("investigation-hint");
  const support = $("investigation-support");
  if (heading) {
    heading.textContent = hasReport
      ? "Investigation findings"
      : state.investigating
        ? "Investigation in progress"
        : "Investigate this alarm";
  }
  if (hint) {
    hint.textContent = hasReport
      ? "Full source-tagged findings from the rules-based investigator. Select a timestamped claim to pin the evidence snapshot."
      : "Review the saved telemetry, command history, and relevant procedures to generate a recommendation with supporting evidence.";
  }
  if (support) {
    support.hidden = hasReport;
  }
  const rerun = $("rerun-investigation");
  if (rerun) {
    rerun.hidden = DEMO_MODE || filed || !hasReport;
    rerun.disabled = state.investigating;
  }
  const assemble = $("assemble");
  if (assemble) {
    assemble.hidden = !DEMO_MODE && (filed || hasReport);
    assemble.disabled = state.investigating || !state.incidentId;
    assemble.textContent = state.investigating
      ? "Investigation in progress"
      : hasReport
        ? "Re-run investigation"
        : "Run investigation";
  }
  const teaser = $("investigation-teaser");
  if (teaser) {
    teaser.hidden = true;
    teaser.textContent = "";
  }
  syncCaseFolds();
}

function orbitSvg(orbit) {
  const o = orbit || { phase: 0.18, illumination: "sun", period_min: 94 };
  const theta = Number(o.phase || 0) * Math.PI * 2;
  const cx = 158;
  const cy = 70;
  const rx = 112;
  const ry = 40;
  const x = (cx + rx * Math.cos(theta)).toFixed(1);
  const y = (cy + ry * Math.sin(theta)).toFixed(1);
  const sun = o.illumination === "sun";
  const mark = sun ? "#7ff0d4" : "#f2a33c";
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

function renderHomeCraft() {
  const craft = $("home-craft");
  const orbit = state.desk?.orbit;
  if (craft) {
    craft.classList.toggle("is-sun", orbit?.illumination === "sun");
    craft.classList.toggle("is-eclipse", Boolean(orbit) && orbit.illumination !== "sun");
  }
  if ($("home-illum")) {
    const illum = orbit?.illumination === "sun" ? "Sunlit" : orbit ? "Eclipse" : "Orbit";
    $("home-illum").textContent = illum;
  }
  if ($("home-orbit-meta")) {
    $("home-orbit-meta").textContent = orbit?.period_min ? `${orbit.period_min} min` : "LEO";
  }
  if ($("home-orbit")) $("home-orbit").innerHTML = orbitSvg(orbit);
}

function renderHomeBrief() {
  const root = $("home-brief");
  if (!root) return;
  root.innerHTML = `
    <p class="home-brief-eyebrow">Investigation workbench</p>
    <p class="home-brief-lede">
      Review sealed telemetry, procedures, and prior incidents for Aurora-1 anomalies —
      then stop at a human decision. Recording an assessment never uplinks a command.
    </p>
    <p class="home-context-line">Simulated mission · Rules-based investigator · No spacecraft commands</p>
    <p class="home-credit">
      <a href="https://www.linkedin.com/in/paulchung39/" target="_blank" rel="noopener noreferrer">Built by Paul Chung</a>
      <span aria-hidden="true"> · </span>
      <a href="/about">Design decisions</a>
    </p>`;
}

function renderHomePath() {
  const root = $("home-path");
  if (!root) return;
  root.classList.remove("is-collapsed");
  const steps = DEMO_STORY.map((beat) => {
    const primary = beat.primary ? " is-primary" : "";
    let action = "";
    if (beat.trust) {
      action = `<button type="button" class="home-demo-link" data-go-trust>Inspect evaluation results</button>`;
    } else if (beat.id) {
      action = `<button type="button" class="home-demo-link" data-open-case="${escapeHtml(beat.id)}" data-jump="investigation">Open ${escapeHtml(beat.id)}</button>`;
    }
    return `<li class="home-demo-step${primary}">
          <span class="home-demo-n" aria-hidden="true">${escapeHtml(beat.n)}</span>
          <div class="home-demo-body">
            <p class="home-demo-title">${escapeHtml(beat.title)}</p>
            <p class="home-demo-copy">${escapeHtml(beat.blurb)}</p>
            ${action}
          </div>
        </li>`;
  }).join("");

  root.innerHTML = `
    <div class="home-path-head">
      <p class="home-path-label">Demo guide</p>
    </div>
    <div class="home-path-body" id="home-path-body">
      <ol class="home-demo-steps">${steps}</ol>
    </div>`;
}

function renderHomeStart() {
  const root = $("home-start");
  if (!root) return;
  const featured = state.incidents.find((item) => item.id === "INC-0204");
  const st = featured?.status || "open";
  let ctaLabel = "Open sample investigation";
  let jump = "investigation";
  let statusNote = "Not investigated yet — open the case, then run the investigation.";
  if (st === "recommended") {
    ctaLabel = "Review sample investigation";
    jump = "action";
    statusNote = "A report is ready for review. Opening the case will not reset it.";
  } else if (st === "filed") {
    ctaLabel = "Open recorded sample";
    jump = "action";
    statusNote = "An assessment is already recorded for this case.";
  }
  root.innerHTML = `
    <div class="home-start-copy">
      <p class="home-start-kicker">Start here</p>
      <h2 class="home-start-title">Investigate a spacecraft power anomaly</h2>
      <p class="home-start-lede">Aurora-1 has triggered a low-voltage warning. Review the telemetry, run an investigation, and inspect the evidence behind the recommendation.</p>
      <p class="home-start-case"><span class="home-start-case-id">Start with INC-0204</span>
        <span class="home-start-case-copy">A heater activation and a payload mode change precede the warning. Examine which event the evidence supports investigating further.</span></p>
      <p class="home-start-status">${escapeHtml(statusNote)}</p>
      <div class="home-start-actions">
        <button type="button" class="btn" data-open-case="INC-0204" data-jump="${escapeHtml(jump)}">${escapeHtml(ctaLabel)}</button>
        <button type="button" class="btn-ghost btn" data-open-slip>Open case</button>
      </div>
    </div>`;
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
  const openN = all.filter((item) => item.status === "open").length;
  const readyN = all.filter((item) => item.status === "recommended").length;
  const filedN = all.filter((item) => item.status === "filed").length;
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

  root.innerHTML = `
    <div class="home-desk-head">
      <div>
        <p class="home-desk-kicker">Cases</p>
        <h2 class="home-desk-title">Incident queue</h2>
      </div>
      <div class="home-desk-actions">
        <button type="button" class="text-btn" data-go-incidents>${openN} not investigated · ${readyN} ready · ${filedN} recorded — all</button>
        <button type="button" class="btn-ghost btn home-desk-open" data-open-slip>Open case</button>
      </div>
    </div>
    <div class="home-desk-list">${list}</div>`;
}

function renderHomeProof() {
  const root = $("home-proof");
  if (!root) return;
  if (state.trustLoading && !state.trust) {
    root.hidden = false;
    root.innerHTML = `
      <div class="home-proof-head">
        <div>
          <p class="home-proof-kicker">Evaluation</p>
          <p class="home-proof-title">Loading evaluation results…</p>
        </div>
      </div>`;
    return;
  }
  const sc = state.trust?.eval?.scorecard;
  if (!sc) {
    root.hidden = false;
    root.innerHTML = `
      <div class="home-proof-head">
        <div>
          <p class="home-proof-kicker">Evaluation</p>
          <p class="home-proof-title">Evaluation results are unavailable right now.</p>
          <p class="home-proof-note">Open Trust to inspect the store, or regenerate the scorecard artifact.</p>
        </div>
        <button type="button" class="btn-ghost btn" data-go-trust>Inspect evaluation results</button>
      </div>`;
    return;
  }
  const checksOk = sc.checks_ok;
  const checksTotal = sc.checks_total;
  const casesTotal = sc.cases_total;
  const gate = state.releaseCompare?.recommendation;
  const gateLabel = gate === "PASS" ? "passed" : gate ? String(gate).toLowerCase() : "unavailable";
  const provider = sc.provider || state.releaseCompare?.candidate?.agent?.provider || "rules";
  root.hidden = false;
  root.innerHTML = `
    <div class="home-proof-head">
      <div>
        <p class="home-proof-kicker">Evaluation</p>
        <p class="home-proof-title">${escapeHtml(`${checksOk}/${checksTotal} checks across ${casesTotal} simulated scenarios`)}</p>
        <p class="home-proof-meta">${escapeHtml(String(provider))} provider · Release gate: ${escapeHtml(gateLabel)}</p>
        <p class="home-proof-note">These results cover the current regression suite, not operational validation.</p>
      </div>
      <button type="button" class="btn" data-go-trust>Inspect evaluation results</button>
    </div>`;
}

function renderHome() {
  renderHomeCraft();
  renderHomeBrief();
  renderHomeStart();
  renderHomeDesk();
  renderHomePath();
  renderHomeProof();
}

async function loadDesk(runId) {
  const wanted = runId || state.deskRunId || "fault1";
  const res = await fetch(apiUrl(`/desk?run_id=${encodeURIComponent(wanted)}`));
  if (!res.ok) throw new Error(`desk ${res.status}`);
  state.desk = await res.json();
  state.deskRunId = state.desk.run_id || wanted;
  if (state.view === "home") renderHomeCraft();
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


function renderCaseNext() {
  const headerNext = $("case-next");
  if (headerNext) {
    headerNext.hidden = true;
    headerNext.innerHTML = "";
  }
  const root = $("case-demo-next");
  if (!root) return;
  const id = state.incidentId;
  const ready = hasSuccessfulInvestigation();
  if (!ready || (id !== "INC-0204" && id !== "INC-0205")) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  root.hidden = false;
  root.innerHTML = `
    <div class="case-demo-card">
      <p class="case-demo-kicker">Demo follow-up</p>
      <h3 class="case-demo-title">See when the recommendation changes</h3>
      <p class="case-demo-copy">Compare this investigation with INC-0212, where the evidence does not meet the procedure’s threshold.</p>
      <div class="case-demo-actions">
        <button type="button" class="btn" data-open-case="INC-0212" data-jump="investigation">Explore the hold case</button>
        <button type="button" class="text-btn" data-go-trust>Inspect the evaluation checks</button>
      </div>
    </div>`;
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
  $("alarm-title").textContent = inc ? caseHeadline(inc) : "Select a case";
  const when = a?.warn ? clock(a.warn.time_s) : openedClock(inc?.opened_at);
  const parts = [];
  if (!a) {
    $("alarm-lede").textContent = "Open a case from an alarm you already have. ORBIT does not detect anomalies.";
    $("alarm-lede").hidden = false;
    hero.classList.remove("is-warn", "is-ok");
    if (inc) {
      if (when) parts.push(caseFactHtml("Opened", when));
      parts.push(caseFactHtml("Entry", alarm));
      if (inc.run_id) {
        const copy = tapeCopy({ id: inc.run_id });
        parts.push(caseFactHtml("Tape", copy.title, null, inc.run_id));
      }
    }
    $("case-meta").innerHTML = parts.join("");
    renderCaseNext();
    return;
  }
  const v = a.warn?.value_num ?? sampleAt(series(alarm), a.t)?.value_num;
  const ch = meta(alarm);
  const crossed = Boolean(a.warn);
  const unit = ch.unit || "";
  $("alarm-lede").hidden = true;
  $("alarm-lede").textContent = "";
  parts.push(`<div class="fact fact-readout ${crossed ? "is-warn" : "is-ok"}" id="hero-readout" aria-label="Alarm reading">
    <dt id="alarm-ch">${escapeHtml(alarm)}</dt>
    <dd>
      <p class="readout-value"><span id="alarm-value">${fmt(v, 2)}</span><span class="unit" id="alarm-unit">${escapeHtml(unit)}</span></p>
      <p class="hero-meter" id="alarm-meter" hidden><span class="track"><i></i></span><span class="pct"></span></p>
      <div class="hero-limit" id="alarm-limit"></div>
    </dd>
  </div>`);
  if (inc) {
    if (a.warn) parts.push(caseFactHtml("First warning (UTC)", when, "warn"));
    else if (when) parts.push(caseFactHtml("Opened", when));
    parts.push(caseFactHtml("Entry", alarm));
    if (inc.run_id) {
      const copy = tapeCopy({ id: inc.run_id });
      parts.push(caseFactHtml("Evidence snapshot", copy.title, null, inc.run_id));
    }
    parts.push(caseFactHtml("Context", "Simulated data · Rules-based investigator"));
  }
  $("case-meta").innerHTML = parts.join("");
  renderAlarmMargin(v, ch);
  $("alarm-limit").innerHTML = `${
    crossed ? `<span class="flag">Warn ${escapeHtml(clock(a.warn.time_s))}</span>` : ""
  }<span class="lim">limit ${fmt(ch.warn_limit, 1)} ${escapeHtml(unit)}</span>`;
  hero.classList.toggle("is-warn", crossed);
  hero.classList.toggle("is-ok", !crossed);
  renderCaseNext();
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
  const crossed = past > 0;
  const direction = below
    ? (crossed ? "below threshold" : "above threshold")
    : (crossed ? "above threshold" : "below threshold");
  el.querySelector(".pct").textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}% ${direction}`;
}

function renderCompare(a) {
  const root = $("compare-grid");
  if (!a) {
    root.innerHTML = "";
    return;
  }
  const concluded = hasSuccessfulInvestigation();
  const healthyMin = meta("THM.heater_b_current").nominal_range?.[0];
  const cards = [
    {
      k: "Heater B",
      v: a.heaterA,
      unit: "A",
      why: concluded && a.heaterMarginal
        ? `Elevated (~${fmt(a.ratio, 1)}× healthy max ${fmt(a.healthyMax, 1)} A) but below EPS-17’s ≥2× threshold.`
        : `Healthy ON range ${fmt(healthyMin, 1)}–${fmt(a.healthyMax, 1)} A (ratio uses healthy max ${fmt(a.healthyMax, 1)} A). Values shown at first warning.`,
      ratio: a.ratio != null ? `${fmt(a.ratio, 1)}× healthy max` : "",
      cls: concluded ? (a.suspect ? "suspect" : a.heaterMarginal ? "marginal" : "") : "",
    },
    {
      k: "Payload",
      v: a.payloadA,
      unit: "A",
      why: concluded && a.payloadSuspect
        ? `SCIENCE_MODE draw is ${fmt(a.payloadRatio, 1)}× the ${fmt(a.payloadHealthy, 1)} A healthy baseline.`
        : a.science
          ? `Most recent mode change: SCIENCE_MODE at ${clock(a.science.time_s)}. Relevance depends on measured current vs ~${fmt(a.payloadHealthy, 1)} A science.`
          : "Payload never left STANDBY in this run.",
      ratio: a.payloadRatio != null ? `${fmt(a.payloadRatio, 1)}× science` : a.mode?.value_text || "",
      cls: concluded ? (a.payloadSuspect ? "suspect-payload" : a.science && !a.suspect ? "confounder" : "") : "",
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
      const pinId = `tl:${item.t}`;
      const on = isLeadUpPinned(item.t);
      const concluded = hasSuccessfulInvestigation();
      const modeChange = item.title === "SCIENCE_MODE";
      const tags = [
        concluded && item.suspect ? `<span class="crumb-tag is-suspect">Suspect</span>` : "",
        concluded && item.marginal && !item.suspect ? `<span class="crumb-tag is-marginal">Elevated</span>` : "",
        item.last && modeChange ? `<span class="crumb-tag is-last">Most recent mode change</span>` : "",
        item.last && !modeChange && !item.suspect ? `<span class="crumb-tag is-last">Most recent command</span>` : "",
        item.warn ? `<span class="crumb-tag is-warn">Warning</span>` : "",
      ].join("");
      const suspectCls = concluded && item.suspect ? "is-suspect" : "";
      const margCls = concluded && item.marginal && !item.suspect ? "is-marginal" : "";
      return `<li class="tl-item kind-${item.kind} ${item.warn ? "is-warn" : ""} ${suspectCls} ${margCls} ${item.last && !item.suspect ? "is-last" : ""} ${on ? "is-on" : ""}" data-t="${item.t}" data-pin-id="${pinId}">
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
  const title = $("procedure-toggle-title");
  if (title) title.textContent = `${id} · procedure`;
  const named = Boolean(a?.suspect || a?.payloadSuspect || a?.batterySuspect);
  const ready = hasSuccessfulInvestigation();
  const status = ready
    ? {
        confirm: a?.warn ? "Evidence present" : "",
        commands: a?.windowEvents.length ? "Evidence present" : "",
        currents: a?.heaterA != null || a?.payloadA != null ? "Evidence present" : "",
        ratio: named ? "Threshold met" : a?.withheld ? "Below threshold" : "",
        payload: a ? "Reviewed" : "",
        action: named ? "Not sent" : a?.withheld ? "Hold" : "",
      }
    : {
        confirm: "",
        commands: "",
        currents: "",
        ratio: "",
        payload: "",
        action: "",
      };
  $("proc").innerHTML = book.steps.map((step) => {
    const label = status[step.id];
    const done = label === "Evidence present" || label === "Threshold met" || label === "Reviewed";
    const blocked = label === "Hold" || label === "Below threshold";
    const human = step.human && Boolean(label) && !blocked;
    return `<li class="${done ? "is-done" : ""} ${human ? "is-action" : ""} ${blocked ? "is-blocked" : ""}">
      <span class="proc-n">${step.n}</span>
      <span class="proc-text">${escapeHtml(step.label)}${blocked && step.human ? " <em>Threshold not met — do not command yet</em>" : ""}</span>
      <span class="proc-state">${escapeHtml(label)}</span>
    </li>`;
  }).join("");
}

function resultEvidencePin(t, label) {
  if (t == null) return "";
  return `<button type="button" class="result-pin" data-t="${t}" data-pin-id="result:${t}">${escapeHtml(label)}</button>`;
}

function buildResultSummary(a) {
  if (!a || !hasSuccessfulInvestigation()) return "";
  const heaterA = a.heaterAAtCmd ?? a.heaterA;
  const ratio = a.ratioAtCmd ?? a.ratio;
  const heaterT = a.heaterCmd?.time_s ?? a.t;
  const warnT = a.warn?.time_s ?? a.t;
  const payloadT = a.science?.time_s ?? a.t;
  if (a.suspect) {
    return {
      status: "Investigation complete · Awaiting operator review",
      heading: "Recommended next step: inhibit Heater B",
      summary: "Heater B’s current exceeds the procedure’s threshold for identifying a suspect load. The payload current is near its expected science-mode level.",
      evidence: [
        {
          html: `Heater B: <strong>${fmt(heaterA, 2)} A</strong> at ${a.heaterCmd ? "heater enable" : "first warning"} (${clock(heaterT)}) — approximately <strong>${fmt(ratio, 1)}×</strong> the upper healthy reference of <strong>${fmt(a.healthyMax, 1)} A</strong>.`,
          t: heaterT,
          tag: "OBSERVED / DERIVED",
        },
        {
          html: `Procedure EPS-17: identifies a load drawing at least <strong>2×</strong> its healthy reference as the prime suspect.`,
          t: null,
          tag: "DOCUMENTED",
          action: "procedure",
        },
        {
          html: `Payload: <strong>${fmt(a.payloadA, 2)} A</strong> at the warning, near the expected science-mode current (~${fmt(a.payloadHealthy, 1)} A).`,
          t: warnT,
          tag: "OBSERVED",
        },
      ],
      uncertaintyTitle: "What remains unconfirmed",
      uncertainty: "The evidence supports Heater B as the suspect load. Confirmation of the physical fault and recovery after intervention are not established by this report.",
    };
  }
  if (a.withheld) {
    return {
      status: "Investigation complete · Awaiting operator review",
      heading: "Recommended next step: hold — do not command",
      summary: "Heater current is elevated but does not meet EPS-17’s ≥2× threshold for recommending an inhibit. The case stays open for more evidence.",
      evidence: [
        {
          html: `Heater B: <strong>${fmt(heaterA, 2)} A</strong> (~<strong>${fmt(ratio, 1)}×</strong> healthy max <strong>${fmt(a.healthyMax, 1)} A</strong>) — below the ≥2× procedure threshold.`,
          t: heaterT,
          tag: "OBSERVED / DERIVED",
        },
        {
          html: `Procedure EPS-17: requires at least <strong>2×</strong> healthy reference before recommending an inhibit.`,
          t: null,
          tag: "DOCUMENTED",
          action: "procedure",
        },
        {
          html: a.science
            ? `SCIENCE_MODE is present, but payload current (<strong>${fmt(a.payloadA, 2)} A</strong>) is not ≥2× science and cannot close the case alone.`
            : `No load clears the ≥2× bar in the sealed window.`,
          t: payloadT,
          tag: "DOCUMENTED",
        },
      ],
      uncertaintyTitle: "What remains missing",
      uncertainty: "A load meeting the ≥2× threshold, or an authorized diagnostic, would change this recommendation. Hold is not an investigation failure.",
    };
  }
  if (a.payloadSuspect) {
    return {
      status: "Investigation complete · Awaiting operator review",
      heading: "Recommended next step: safe payload to STANDBY",
      summary: "Payload current meets the procedure threshold. Heater current does not support a heater inhibit.",
      evidence: [
        {
          html: `Payload: <strong>${fmt(a.payloadA, 2)} A</strong> (~<strong>${fmt(a.payloadRatio, 1)}×</strong> science baseline ${fmt(a.payloadHealthy, 1)} A).`,
          t: warnT,
          tag: "OBSERVED / DERIVED",
        },
        {
          html: `Heater B remains below the ≥2× inhibit threshold.`,
          t: heaterT,
          tag: "OBSERVED",
        },
      ],
      uncertaintyTitle: "What remains unconfirmed",
      uncertainty: "Physical fault confirmation and recovery after intervention are not established by this report.",
    };
  }
  if (a.batterySuspect) {
    return {
      status: "Investigation complete · Awaiting operator review",
      heading: "Recommended next step: continue EPS-09",
      summary: "Pack voltage sagged with healthy load currents. Do not inhibit the heater or payload.",
      evidence: [
        {
          html: `Battery voltage crossed its warning with load currents remaining healthy.`,
          t: warnT,
          tag: "OBSERVED",
        },
      ],
      uncertaintyTitle: "What remains unconfirmed",
      uncertainty: "Pack health checkout remains an operator follow-up. This report does not confirm a completed recovery.",
    };
  }
  return {
    status: "Investigation complete · Awaiting operator review",
    heading: "Recommended next step: keep reading",
    summary: "No load currently meets a procedure threshold for action.",
    evidence: [],
    uncertaintyTitle: "What remains unconfirmed",
    uncertainty: "Additional measurements or an authorized diagnostic may change the recommendation.",
  };
}

function renderResultSummary(a) {
  const root = $("result-summary");
  if (!root) return;
  if (!hasSuccessfulInvestigation() || !a || state.incident?.status === "filed") {
    // Still show for filed? Show compact. Actually show for ready and filed.
  }
  if (!hasSuccessfulInvestigation() || !a) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  const model = buildResultSummary(a);
  if (!model) {
    root.hidden = true;
    root.innerHTML = "";
    return;
  }
  const evidence = (model.evidence || [])
    .map((row) => {
      const tag = row.tag
        ? `<span class="tag tag-${tagClass(row.tag)}" title="${escapeHtml(TAG_MEANING[tagClass(row.tag)] || "")}" tabindex="0">${escapeHtml(row.tag)}</span>`
        : "";
      let action = "";
      if (row.action === "procedure") {
        action = `<button type="button" class="text-btn result-jump" data-jump-procedure>Review procedure</button>`;
      } else if (row.t != null) {
        action = resultEvidencePin(row.t, "Inspect supporting evidence");
      }
      return `<li class="result-evidence-item">
        <div class="result-evidence-main">${row.html} ${tag}</div>
        ${action ? `<div class="result-evidence-actions">${action}</div>` : ""}
      </li>`;
    })
    .join("");
  root.hidden = false;
  root.innerHTML = `
    ${evidence ? `<ul class="result-evidence">${evidence}</ul>` : ""}
    <div class="result-uncertainty">
      <h3>${escapeHtml(model.uncertaintyTitle)}</h3>
      <p>${escapeHtml(model.uncertainty)}</p>
    </div>
    <p class="result-boundary">Recommendation only. ORBIT cannot send spacecraft commands.</p>
    <div class="result-quick-actions">
      <button type="button" class="text-btn" data-jump-evidence>Inspect supporting evidence</button>
      <button type="button" class="text-btn" data-jump-procedure>Review procedure</button>
    </div>`;
}

function renderDecision(a) {
  const status = $("decide-meta");
  const fileBtn = $("file-incident");
  const openPane = $("decide-open");
  const filedPane = $("decide-filed");
  const panel = $("action");
  const filed = state.incident?.status === "filed";
  const ready = hasSuccessfulInvestigation();
  openPane.hidden = filed;
  filedPane.hidden = !filed;
  fileBtn.hidden = filed || !ready;
  fileBtn.disabled = Boolean(state.filing);
  fileBtn.textContent = state.filing ? "Recording…" : "Record assessment";
  panel?.classList.toggle("is-pending", !filed && !ready);
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
        const hold = isHoldFeedback(a, fb);
        badge.textContent = hold
          ? `${feedbackVerdictLabel(fb.verdict, true)} · hold`
          : `${feedbackVerdictLabel(fb.verdict, false)} · ${fb.hypothesis_key}`;
      } else {
        badge.hidden = true;
        badge.textContent = "";
      }
    }
  }
  const statusLine = $("decide-status-line");
  if (!ready) {
    if (statusLine) statusLine.textContent = "Pending";
    if (state.investigating) {
      $("decide-title").textContent = "Investigation in progress";
      $("decide-sub").textContent = "The recommendation will appear here when the report is ready.";
    } else if (investigationFailed()) {
      $("decide-title").textContent = "Investigation did not complete";
      $("decide-sub").textContent = "Evidence on this page is unchanged. Re-run to generate a new report; any previous successful report remains available only if still stored on the case.";
    } else {
      $("decide-title").textContent = "Pending investigation";
      $("decide-sub").textContent = "Run the investigation to generate a recommendation. Results will appear here.";
    }
    status.textContent = "";
    fileBtn.hidden = true;
    renderResultSummary(null);
    renderDecisionContext(null);
    renderCaseNext();
    return;
  }
  if (!a) {
    if (statusLine) statusLine.textContent = "Pending";
    $("decide-title").textContent = "Pending investigation";
    $("decide-sub").textContent = "Select a case to see a next step.";
    status.textContent = "";
    fileBtn.hidden = true;
    renderResultSummary(null);
    renderDecisionContext(null);
    renderCaseNext();
    return;
  }
  if (statusLine) {
    statusLine.textContent = filed ? "Assessment recorded" : "Investigation complete · Awaiting operator review";
  }
  const model = buildResultSummary(a);
  if (a.suspect) {
    $("decide-title").textContent = "Inhibit Heater B";
    $("decide-sub").textContent = model.summary;
    status.textContent = "Not sent";
    if (filed) {
      $("filed-action-title").textContent = "Inhibit Heater B";
      $("filed-action-sub").textContent = "Saved with this case. ORBIT did not uplink a command. Recording does not confirm that the physical anomaly is resolved.";
    }
  } else if (a.payloadSuspect) {
    $("decide-title").textContent = "Safe payload to STANDBY";
    $("decide-sub").textContent = model.summary;
    status.textContent = "Not sent";
    if (filed) {
      $("filed-action-title").textContent = "Safe payload to STANDBY";
      $("filed-action-sub").textContent = "Saved with this case. ORBIT did not uplink a command.";
    }
  } else if (a.batterySuspect) {
    $("decide-title").textContent = "Continue EPS-09";
    $("decide-sub").textContent = model.summary;
    status.textContent = "Not sent";
    if (filed) {
      $("filed-action-title").textContent = "Continue EPS-09";
      $("filed-action-sub").textContent = "Saved with this case. ORBIT did not uplink a command.";
    }
  } else if (!a.warn) {
    $("decide-title").textContent = "No action";
    $("decide-sub").textContent = "No warning on this case.";
    status.textContent = "";
    if (filed) $("filed-action-title").textContent = "No action";
  } else if (a.withheld) {
    $("decide-title").textContent = "Hold — do not command";
    $("decide-sub").textContent = model.summary;
    status.textContent = "No command";
    if (filed) {
      $("filed-action-title").textContent = "Hold — do not command";
      $("filed-action-sub").textContent = "Threshold not met. Saved with this case. ORBIT did not uplink a command.";
    }
  } else {
    $("decide-title").textContent = "Keep reading";
    $("decide-sub").textContent = model.summary;
    status.textContent = "";
    if (filed) $("filed-action-title").textContent = "Keep reading";
  }
  renderResultSummary(a);
  renderDecisionContext(a);
  renderCaseNext();
}

function renderFindings() {
  const body = $("findings-body");
  updateInvestigationChrome();
  if (state.investigating) {
    renderInvestigationProgress();
    return;
  }
  if (state.report) {
    const sections = state.report.split(/\n(?=## )/);
    body.innerHTML = sections
      .filter((block) => {
        const trimmed = block.trim();
        const title = sectionTitle(trimmed);
        if (/^#\s+Investigation\b/i.test(trimmed)) return false;
        return !/^tool log$/i.test(title) && !/^hypothesis$/i.test(title) && !/recommended human decision/i.test(title);
      })
      .map((raw) => {
        const block = raw.trim();
        const title = sectionTitle(block);
        if (/^timeline$/i.test(title)) return renderTimelineFinding(block);
        return `<article class="finding md"><p class="finding-section-kicker">Investigation findings</p>${renderMd(block)}</article>`;
      })
      .join("");
    return;
  }
  if (!analysis()) {
    body.innerHTML = `<div class="investigation-empty"><p>Select a case to begin.</p></div>`;
    return;
  }
  body.innerHTML = `<div class="investigation-empty">
    <p>Run investigation to generate a source-tagged report. The recommendation will appear in the Recommendation panel once complete.</p>
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
  renderKnowledge();
}

async function openIncident(incidentId, jump) {
  try {
    await loadIncident(incidentId);
    const ready = hasSuccessfulInvestigation();
    if (jump === "closeout") {
      openDoc(incidentId);
    } else if (jump === "action" || (ready && jump !== "investigation" && jump !== "findings" && jump !== "evidence" && jump !== "procedure" && jump !== "knowledge")) {
      $("action")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (jump === "findings" || jump === "investigation") {
      $("investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (jump === "evidence") {
      state.evidenceOpen = true;
      syncEvidenceBundle();
      $("evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (jump === "procedure") {
      state.procedureOpen = true;
      syncProcedureBundle();
      $("procedure")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (jump === "knowledge") {
      state.knowledgeOpen = true;
      syncKnowledgeBundle();
      $("knowledge")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (!jump && ready) {
      $("action")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (!jump) {
      $("investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    const lede = $("alarm-lede");
    if (lede) {
      lede.hidden = false;
      lede.textContent = `Could not open ${incidentId}: ${err.message}`;
    }
  }
}

async function loadIncident(incidentId) {
  state.incidentId = incidentId;
  state.incident = state.incidents.find((item) => item.id === incidentId) || null;
  state.feedback = state.incident?.feedback || null;
  state.runId = state.incident?.run_id || null;
  state.report = null;
  state.pinT = null;
  state.pinSource = null;
  state.hoverT = null;
  enterCase();
  $("stage").scrollTop = 0;
  renderIncidents();
  const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(incidentId)}/workspace`));
  if (!res.ok) throw new Error(`workspace ${res.status}`);
  state.workspace = await res.json();
  if (state.workspace.incident) {
    state.incident = state.workspace.incident;
    state.feedback = state.incident.feedback || state.feedback;
    const inc = state.incident;
    if (inc.investigation_report) {
      state.report = inc.investigation_report;
    } else if (inc.status === "filed" && inc.closeout) {
      state.report = inc.closeout;
    }
  }
  state.knowledgeOpen = false;
  state.procedureOpen = false;
  state.runId = state.workspace.run_id;
  const a = analysis();
  const seed = a?.warn?.time_s ?? a?.heaterCmd?.time_s ?? null;
  state.pinT = seed != null ? resolvePinTime(seed) : null;
  state.pinSource = null;
  renderCase();
  syncCaseFolds();
  const input = $("knowledge-q");
  if (input) input.value = "";
  await searchLibrary(likeThisQuery(), { grounded: true });
}

async function runInvestigation(incidentId) {
  const id = incidentId || state.incidentId;
  if (!id || state.investigating) return;
  try {
    if (state.incidentId !== id) {
      await loadIncident(id);
    }
    $("investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
    await assemble();
  } catch (err) {
    window.alert(`Could not open ${id}: ${err.message}`);
  }
}

async function assemble() {
  if (!state.incidentId || state.investigating) return;
  const previousReport = state.report;
  state.investigating = true;
  state.report = null;
  renderFindings();
  renderDecision(analysis());
  try {
    const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(state.incidentId)}/investigate`), {
      method: "POST",
    });
    if (!res.ok) throw new Error(`investigate ${res.status}`);
    const data = await res.json();
    state.report = data.report;
    applyIncidentPatch(state.incidentId, {
      status: data.status || "recommended",
      investigation_report: data.report,
      investigated_at: data.investigated_at || null,
    });
    state.knowledgeOpen = false;
    renderIncidents();
    renderAlarm(analysis());
    renderDecision(analysis());
    announceLive("Investigation complete. Recommendation ready for review.");
  } catch (err) {
    state.report = previousReport
      ? previousReport
      : `# Could not investigate\n\n${err.message}`;
    if (previousReport) {
      announceLive(`Investigation failed. Previous report remains available. ${err.message}`);
      window.alert(`Investigation failed. The previous report remains on screen.\n\n${err.message}`);
    } else {
      state.report = `# Could not investigate\n\n${err.message}`;
      announceLive(`Investigation failed. ${err.message}`);
    }
  } finally {
    stopInvestigationAnimation();
    state.investigating = false;
    renderFindings();
    renderDecision(analysis());
    renderCompare(analysis());
    renderTimeline(analysis());
    renderProc(analysis());
    syncCaseFolds();
    const target = hasSuccessfulInvestigation() ? $("action") : $("investigation");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
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

async function fileIncident(ev) {
  if (ev) ev.preventDefault();
  if (!state.incidentId || state.filing || state.incident?.status === "filed") return;
  state.filing = true;
  const confirmBtn = $("confirm-file");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Recording…";
  try {
    const res = await fetch(apiUrl(`/incidents/${encodeURIComponent(state.incidentId)}/file`), {
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
    applyIncidentPatch(filed.id, filed);
    closeFileSlip();
    renderIncidents();
    renderAlarm(analysis());
    renderDecision(analysis());
    await refreshDocs();
    const input = $("knowledge-q");
    if (input) input.value = "";
    await searchLibrary(likeThisQuery(), { grounded: true });
    $("alarm").scrollIntoView({ behavior: "smooth", block: "start" });
  } finally {
    state.filing = false;
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Record assessment";
    renderDecision(analysis());
  }
}

function fillDocReader(doc, why) {
  const kind = libraryKind(doc);
  const close = libraryClose(doc);
  const whyText = why || (close ? `${libraryUse(doc)} · ${close}` : libraryUse(doc));
  return { kind, whyText };
}

async function openDoc(id, opts = {}) {
  const res = await fetch(apiUrl(`/documents/${encodeURIComponent(id)}`));
  if (!res.ok) return;
  const doc = await res.json();
  state.openDocId = doc.id;
  state.openDoc = doc;
  const grounded = groundedDocs().find((g) => g.doc.id === doc.id);
  const { whyText } = fillDocReader(doc, opts.why || grounded?.why);

  const onCase = state.view === "case" && state.incidentId;
  if (onCase || opts.forceCase) {
    if (state.view !== "case" && state.incidentId) enterCase();
    state.knowledgeOpen = true;
    syncKnowledgeBundle();
    $("reader-kind").textContent = libraryKindLabel(doc);
    $("reader-title").textContent = doc.title;
    $("reader-why").textContent = whyText;
    $("reader-body").innerHTML = renderMd(doc.body, { skipTitle: true });
    const actions = $("reader-actions");
    if (actions) {
      const listed = state.incidents.find((item) => item.id === doc.id);
      actions.innerHTML = listed && listed.id !== state.incidentId
        ? `<button type="button" class="btn-bar" data-open-listed="${escapeHtml(doc.id)}">Open case ${escapeHtml(doc.id)}</button>`
        : "";
    }
    const reader = $("knowledge-reader");
    if (reader) {
      reader.hidden = false;
      reader.className = `knowledge-reader kind-${libraryKind(doc)}`;
    }
    renderKnowledge();
    $("knowledge")?.scrollIntoView({ behavior: "smooth", block: "start" });
    reader?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  openDocSlip(doc, whyText);
}

function openDocSlip(doc, whyText) {
  const slip = $("doc-slip");
  if (!slip) return;
  $("doc-slip-kind").textContent = libraryKindLabel(doc);
  $("doc-slip-title").textContent = doc.title;
  $("doc-slip-why").textContent = whyText || libraryUse(doc);
  $("doc-slip-body").innerHTML = renderMd(doc.body, { skipTitle: true });
  slip.hidden = false;
}

function closeDocSlip() {
  const slip = $("doc-slip");
  if (slip) slip.hidden = true;
}

function closeReader() {
  state.openDocId = null;
  state.openDoc = null;
  const reader = $("knowledge-reader");
  if (reader) {
    reader.hidden = true;
    reader.className = "knowledge-reader";
  }
  closeDocSlip();
  renderKnowledge();
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

function knowledgeCard(doc, opts = {}) {
  const kind = libraryKind(doc);
  const on = doc.id === state.openDocId ? "is-on" : "";
  const close = libraryClose(doc);
  const score = doc.score != null
    ? `<span class="knowledge-score" title="Search similarity, not confidence">${Number(doc.score).toFixed(2)} · similarity</span>`
    : "";
  return `<button type="button" class="knowledge-card kind-${kind} ${on} ${opts.grounded ? "is-grounded" : ""}" data-doc="${escapeHtml(doc.id)}">
    <span class="knowledge-card-top">
      <span class="kind-chip kind-${kind}">${escapeHtml(libraryKindLabel(doc))}</span>
      <strong>${escapeHtml(doc.id)}</strong>
      ${score}
    </span>
    <span class="knowledge-card-title">${escapeHtml(doc.title)}</span>
    <span class="knowledge-card-use">${escapeHtml(opts.why || libraryUse(doc))}</span>
    ${close ? `<span class="knowledge-card-close">${escapeHtml(close)}</span>` : ""}
  </button>`;
}

function knowledgeToggleSummary(ground, related) {
  const bits = [];
  if (ground.length) bits.push(...ground.map((g) => g.doc.id));
  else bits.push("No grounded docs");
  if (related.length) bits.push(`${related.length} related`);
  return bits.slice(0, 4).join(" · ");
}

function renderKnowledge() {
  const root = $("knowledge-list");
  const status = $("knowledge-status");
  const clear = $("knowledge-clear");
  const title = $("knowledge-toggle-title");
  const reader = $("knowledge-reader");
  if (clear) clear.hidden = !state.libraryQuery;
  if (!root) return;

  const reading = Boolean(state.openDocId && state.openDoc && reader && !reader.hidden);
  if (reader && !state.openDocId) reader.hidden = true;

  if (state.librarySearching) {
    if (status) status.textContent = "Searching the index…";
    root.innerHTML = `<p class="knowledge-hint">Searching…</p>`;
    return;
  }

  const ground = groundedDocs();
  const groundIds = new Set(ground.map((g) => g.doc.id));
  const query = state.libraryQuery;

  if (query) {
    const hits = state.libraryHits || [];
    if (status) {
      status.textContent = hits.length
        ? `${hits.length} result${hits.length === 1 ? "" : "s"} for “${query}”`
        : `Nothing matched “${query}”`;
    }
    if (title) title.textContent = hits.length ? `Search · ${hits.length} hits` : "Search · no hits";
    if (!hits.length) {
      root.innerHTML = `<p class="knowledge-hint">No documents matched. Try a shorter phrase, or clear search to return to this case.</p>`;
      return;
    }
    root.innerHTML = `<div class="knowledge-group">
      <p class="knowledge-group-kicker">Search results</p>
      <div class="knowledge-grid">${hits.map((doc) => knowledgeCard(doc)).join("")}</div>
    </div>`;
    return;
  }

  const related = (state.libraryHits || []).filter((doc) => !groundIds.has(doc.id)).slice(0, 6);
  if (title) title.textContent = knowledgeToggleSummary(ground, related);
  if (status) {
    status.textContent = state.incidentId
      ? `${ground.length} referenced · ${related.length} related (search similarity)`
      : "Open a case to load procedures and prior incidents";
  }

  let html = "";
  if (ground.length) {
    html += `<div class="knowledge-group is-ground">
      <p class="knowledge-group-kicker">Referenced in this investigation</p>
      <p class="knowledge-group-note">Chosen by the same analysis as the investigation — not by search rank.</p>
      <div class="knowledge-grid">${ground.map((g) => knowledgeCard(g.doc, { why: g.why, grounded: true })).join("")}</div>
    </div>`;
  } else {
    html += `<p class="knowledge-hint">Run investigation or open a case with a matching procedure to load referenced documents.</p>`;
  }
  if (related.length) {
    html += `<div class="knowledge-group">
      <p class="knowledge-group-kicker">Related documents</p>
      <p class="knowledge-group-note">Search-similarity neighbors from the local index. Related is not the same as supporting evidence.</p>
      <div class="knowledge-grid">${related.map((doc) => knowledgeCard(doc)).join("")}</div>
    </div>`;
  }
  root.innerHTML = html;
}

async function searchLibrary(query, opts = {}) {
  const q = (query || "").trim();
  state.libraryQuery = opts.grounded ? "" : q;
  if (!q) {
    state.libraryHits = null;
    renderKnowledge();
    return;
  }
  state.librarySearching = true;
  renderKnowledge();
  try {
    const res = await fetch(apiUrl(`/search?q=${encodeURIComponent(q)}&limit=20`));
    if (!res.ok) throw new Error(`search ${res.status}`);
    state.libraryHits = await res.json();
  } catch {
    state.libraryHits = [];
  } finally {
    state.librarySearching = false;
    renderKnowledge();
  }
}

function resetKnowledgeToCase() {
  const input = $("knowledge-q");
  if (input) input.value = "";
  state.libraryQuery = "";
  if (!state.incidentId) {
    state.libraryHits = null;
    renderKnowledge();
    return;
  }
  searchLibrary(likeThisQuery(), { grounded: true });
}

function focusKnowledgeSearch() {
  if (!state.incidentId) {
    enterIncidents();
    return;
  }
  if (state.view !== "case") enterCase();
  state.knowledgeOpen = true;
  syncKnowledgeBundle();
  $("knowledge")?.scrollIntoView({ behavior: "smooth", block: "start" });
  const input = $("knowledge-q");
  if (input) {
    input.focus();
    input.select();
  }
}

async function refreshDocs() {
  const res = await fetch(apiUrl("/documents"));
  if (!res.ok) return;
  state.docs = await res.json();
  renderKnowledge();
}

let knowledgeTimer = 0;
function onKnowledgeTyped() {
  window.clearTimeout(knowledgeTimer);
  knowledgeTimer = window.setTimeout(() => {
    const q = ($("knowledge-q")?.value || "").trim();
    if (!q) {
      resetKnowledgeToCase();
      return;
    }
    searchLibrary(q);
  }, 220);
}

function bind() {
  window.addEventListener("popstate", () => {
    routeFromPath(location.pathname).catch((err) => {
      console.warn("routeFromPath", err);
    });
  });
  $("tab-home").addEventListener("click", () => goHome());
  $("tab-incidents").addEventListener("click", () => goIncidents());
  $("tab-trust").addEventListener("click", () => goTrust());
  $("back-incidents").addEventListener("click", () => goIncidents());
  $("go-home-brand").addEventListener("click", () => goHome());
  $("home").addEventListener("click", (ev) => {
    if (ev.target.closest("#home-path-toggle")) {
      state.pathExpanded = !state.pathExpanded;
      renderHomePath();
      return;
    }
    if (ev.target.closest("[data-go-incidents]")) {
      goIncidents();
      return;
    }
    if (ev.target.closest("[data-go-trust]")) {
      goTrust();
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
  $("knowledge-form")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    window.clearTimeout(knowledgeTimer);
    const q = ($("knowledge-q")?.value || "").trim();
    if (!q) {
      resetKnowledgeToCase();
      return;
    }
    searchLibrary(q);
  });
  $("knowledge-q")?.addEventListener("input", onKnowledgeTyped);
  $("knowledge-clear")?.addEventListener("click", () => {
    window.clearTimeout(knowledgeTimer);
    resetKnowledgeToCase();
    $("knowledge-q")?.focus();
  });
  $("knowledge-list")?.addEventListener("click", (ev) => {
    const listed = ev.target.closest("[data-open-listed]");
    if (listed) {
      openIncident(listed.dataset.openListed);
      return;
    }
    const btn = ev.target.closest("[data-doc]");
    if (btn) openDoc(btn.dataset.doc);
  });
  $("knowledge-reader")?.addEventListener("click", (ev) => {
    const listed = ev.target.closest("[data-open-listed]");
    if (listed) openIncident(listed.dataset.openListed);
  });
  $("knowledge-reader-close")?.addEventListener("click", closeReader);
  $("knowledge-toggle")?.addEventListener("click", () => {
    state.knowledgeOpen = !state.knowledgeOpen;
    syncKnowledgeBundle();
  });
  $("procedure-toggle")?.addEventListener("click", () => {
    state.procedureOpen = !state.procedureOpen;
    syncProcedureBundle();
  });
  $("doc-slip-close")?.addEventListener("click", closeDocSlip);
  $("doc-slip")?.addEventListener("click", (ev) => {
    if (ev.target.id === "doc-slip") closeDocSlip();
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
  $("trust-desk").addEventListener("click", (ev) => {
    const syncBtn = ev.target.closest("[data-source-sync]");
    if (syncBtn) {
      syncSource(syncBtn.dataset.sourceSync);
      return;
    }
    const cat = ev.target.closest("[data-explorer-cat]");
    if (cat) {
      setExplorerCategory(cat.dataset.explorerCat);
      return;
    }
    const docFilter = ev.target.closest("[data-explorer-doc-filter]");
    if (docFilter) {
      setExplorerDocFilter(docFilter.dataset.explorerDocFilter);
      return;
    }
    const select = ev.target.closest("[data-explorer-select]");
    if (select) {
      selectExplorerRecord(select.dataset.explorerSelect, { openDetail: true });
      return;
    }
    if (ev.target.closest("[data-explorer-detail-back]")) {
      closeExplorerDetail();
      return;
    }
    const openCase = ev.target.closest("[data-explorer-open-case]");
    if (openCase) {
      openSlipFromDataset(openCase.dataset.explorerOpenCase);
      return;
    }
    const inspectDataset = ev.target.closest("[data-explorer-inspect-dataset]");
    if (inspectDataset) {
      openInspector({ runId: inspectDataset.dataset.explorerInspectDataset, window: "full" });
      return;
    }
    const inspectSnapshot = ev.target.closest("[data-explorer-inspect-snapshot]");
    if (inspectSnapshot) {
      const run = explorerSnapshots().find((row) => row.id === inspectSnapshot.dataset.explorerInspectSnapshot);
      if (run) openInspectorForSnapshot(run);
      else openInspector({ runId: inspectSnapshot.dataset.explorerInspectSnapshot, window: "full" });
      return;
    }
    const openIncident = ev.target.closest("[data-explorer-open-incident]");
    if (openIncident) {
      loadIncident(openIncident.dataset.explorerOpenIncident);
      return;
    }
    const readDoc = ev.target.closest("[data-explorer-read-doc]");
    if (readDoc) {
      openDoc(readDoc.dataset.explorerReadDoc);
      return;
    }
    if (ev.target.closest("[data-trust-back]")) {
      enterTrustOverview();
      return;
    }
    const releaseCase = ev.target.closest("[data-release-case]");
    if (releaseCase) {
      enterTrustReleaseCase(releaseCase.dataset.releaseCase);
      return;
    }
    if (ev.target.closest("[data-promote-baseline]:not(:disabled)")) {
      promoteBaseline();
      return;
    }
    const tape = ev.target.closest("[data-trust-tape]");
    if (tape) {
      loadDesk(tape.dataset.trustTape).then(() => {
        if (state.view === "trust") renderTrust();
      });
      return;
    }
    const inspect = ev.target.closest("[data-trust-inspect]");
    if (inspect) {
      const run = explorerSnapshots().find((row) => row.id === inspect.dataset.trustInspect);
      if (run) openInspectorForSnapshot(run);
      else openInspector({ runId: inspect.dataset.trustInspect });
      return;
    }
    const doc = ev.target.closest("[data-trust-doc]");
    if (doc) openDoc(doc.dataset.trustDoc);
  });
  $("trust-desk").addEventListener("keydown", (ev) => {
    const cat = ev.target.closest("[data-explorer-cat]");
    if (cat && (ev.key === "ArrowRight" || ev.key === "ArrowLeft")) {
      ev.preventDefault();
      const order = ["datasets", "snapshots", "documents"];
      const idx = order.indexOf(cat.dataset.explorerCat);
      const next = order[(idx + (ev.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
      setExplorerCategory(next);
      $(`source-cat-${next}`)?.focus();
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
  $("incident-alarm-time")?.addEventListener("input", updateBindPreview);
  $("new-incident")?.querySelector('[name="title"]')?.addEventListener("input", (ev) => {
    const input = ev.target;
    if ((input.value || "").trim()) input.dataset.userEdited = "true";
    else delete input.dataset.userEdited;
  });
  $("timeline").addEventListener("click", (ev) => {
    const node = ev.target.closest("[data-t]");
    if (!node) return;
    ev.preventDefault();
    pinTape(node.dataset.t, { scroll: true, source: node.dataset.pinId || null });
  });
  $("case-desk").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-go-trust]")) {
      goTrust();
      return;
    }
    if (ev.target.closest("[data-jump-evidence]")) {
      state.evidenceOpen = true;
      syncEvidenceBundle();
      $("evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (ev.target.closest("[data-jump-procedure]")) {
      state.procedureOpen = true;
      syncProcedureBundle();
      $("procedure")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const resultPin = ev.target.closest(".result-pin[data-t]");
    if (resultPin) {
      pinTape(resultPin.dataset.t, { scroll: true, source: resultPin.dataset.pinId || null });
      return;
    }
    const openCase = ev.target.closest("[data-open-case]");
    if (openCase) {
      openIncident(openCase.dataset.openCase, openCase.dataset.jump);
      return;
    }
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
    if (where === "investigation" || where === "findings") {
      $("investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (where === "evidence") {
      state.evidenceOpen = true;
      syncEvidenceBundle();
      $("evidence")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (where === "procedure") {
      state.procedureOpen = true;
      syncProcedureBundle();
      $("procedure")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (where === "knowledge") {
      state.knowledgeOpen = true;
      syncKnowledgeBundle();
      $("knowledge")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    $("investigation")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("findings-body").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-t]");
    if (!btn) return;
    pinTape(btn.dataset.t, { scroll: true, source: btn.dataset.pinId || null });
  });
  document.querySelector(".seg").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-window]");
    if (!btn) return;
    state.window = btn.dataset.window;
    document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("is-on", b === btn));
    renderCase();
  });
  $("assemble").addEventListener("click", assemble);
  $("rerun-investigation")?.addEventListener("click", assemble);
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
  $("open-proc").addEventListener("click", () => openDoc(procedureId(analysis()), { forceCase: true }));
  document.addEventListener("keydown", (ev) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(ev.target?.tagName || "");
    if ((ev.key === "k" || ev.key === "K") && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      focusKnowledgeSearch();
      return;
    }
    if (ev.key === "/" && !typing && !ev.metaKey && !ev.ctrlKey) {
      ev.preventDefault();
      focusKnowledgeSearch();
      return;
    }
    if (ev.key !== "Escape") return;
    if ($("doc-slip") && !$("doc-slip").hidden) {
      closeDocSlip();
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
      window.clearTimeout(knowledgeTimer);
      resetKnowledgeToCase();
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
  if (DEMO_MODE) document.body.classList.add("demo-mode");
  bind();
  const [runsRes, incidentRes, alarmRes, docsRes] = await Promise.all([
    fetch(apiUrl("/runs")),
    fetch(apiUrl(DEMO_MODE ? "/incidents?fresh=1" : "/incidents")),
    fetch(apiUrl("/entry-alarms")),
    fetch(apiUrl("/documents")),
  ]);
  state.runs = await runsRes.json();
  state.incidents = await incidentRes.json();
  state.alarms = await alarmRes.json();
  state.docs = docsRes.ok ? await docsRes.json() : [];
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
  if (state.view !== "trust") {
    loadTrust().catch(() => {});
  }
}

boot().catch((err) => {
  const lede = $("home-lede");
  if (lede) {
    lede.hidden = false;
    lede.textContent = err.message;
  }
});
