/* ORBIT landing — the sealed tape, drawn from the real run.
   Data: runs/fault1.csv, 14:26:25 → 14:39:40 UTC, 120 samples.
   [clock, THM.heater_b_current (A), EPS.bus_voltage (V), PAY.mode] */
(() => {
  "use strict";

  const D = [["14:26:25",0.005,28.496,"STANDBY"],["14:26:30",0,28.393,"STANDBY"],["14:26:35",0,28.37,"STANDBY"],["14:26:45",0.036,28.442,"STANDBY"],["14:26:50",0,28.51,"STANDBY"],["14:26:55",0.022,28.415,"STANDBY"],["14:27:05",0.049,28.494,"STANDBY"],["14:27:10",0,28.441,"STANDBY"],["14:27:15",0,28.488,"STANDBY"],["14:27:25",0,28.422,"STANDBY"],["14:27:30",0.021,28.459,"STANDBY"],["14:27:35",0,28.405,"STANDBY"],["14:27:45",0.015,28.43,"STANDBY"],["14:27:50",0.005,28.411,"STANDBY"],["14:27:55",0,28.431,"STANDBY"],["14:28:05",0,28.413,"STANDBY"],["14:28:10",0,28.436,"STANDBY"],["14:28:15",0,28.37,"STANDBY"],["14:28:25",0.028,28.312,"STANDBY"],["14:28:30",0.016,28.422,"STANDBY"],["14:28:35",0.003,28.34,"STANDBY"],["14:28:45",0,28.339,"STANDBY"],["14:28:50",0,28.423,"STANDBY"],["14:28:55",0,28.339,"STANDBY"],["14:29:05",0.032,28.354,"STANDBY"],["14:29:10",0.013,28.402,"STANDBY"],["14:29:15",0,28.439,"STANDBY"],["14:29:25",0,28.49,"STANDBY"],["14:29:30",0.031,28.419,"STANDBY"],["14:29:35",0.012,28.373,"STANDBY"],["14:29:45",3.739,26.727,"STANDBY"],["14:29:50",3.739,26.72,"STANDBY"],["14:29:55",3.716,26.682,"STANDBY"],["14:30:05",3.712,26.711,"STANDBY"],["14:30:10",3.706,26.692,"STANDBY"],["14:30:15",3.773,26.709,"STANDBY"],["14:30:25",3.791,26.739,"STANDBY"],["14:30:30",3.7,26.665,"STANDBY"],["14:30:35",3.752,26.686,"STANDBY"],["14:30:45",3.728,26.691,"STANDBY"],["14:30:50",3.751,26.65,"STANDBY"],["14:30:55",3.747,26.673,"STANDBY"],["14:31:05",3.78,26.607,"STANDBY"],["14:31:10",3.76,26.561,"STANDBY"],["14:31:15",3.695,26.623,"STANDBY"],["14:31:25",3.747,26.61,"STANDBY"],["14:31:30",3.735,26.647,"STANDBY"],["14:31:35",3.702,26.602,"STANDBY"],["14:31:45",3.739,26.633,"STANDBY"],["14:31:50",3.74,26.665,"STANDBY"],["14:31:55",3.729,26.566,"STANDBY"],["14:32:05",3.734,26.638,"STANDBY"],["14:32:10",3.783,26.544,"STANDBY"],["14:32:15",3.743,26.603,"STANDBY"],["14:32:25",3.787,26.535,"STANDBY"],["14:32:30",3.702,26.625,"STANDBY"],["14:32:35",3.714,26.658,"STANDBY"],["14:32:45",3.747,26.532,"STANDBY"],["14:32:50",3.674,26.587,"STANDBY"],["14:32:55",3.763,26.542,"STANDBY"],["14:33:05",3.726,26.494,"STANDBY"],["14:33:10",3.747,26.586,"STANDBY"],["14:33:15",3.726,26.581,"STANDBY"],["14:33:25",3.762,26.579,"STANDBY"],["14:33:30",3.752,26.568,"STANDBY"],["14:33:35",3.733,26.494,"STANDBY"],["14:33:45",3.755,26.593,"STANDBY"],["14:33:50",3.731,26.558,"STANDBY"],["14:33:55",3.719,26.532,"STANDBY"],["14:34:05",3.758,26.651,"STANDBY"],["14:34:10",3.772,26.562,"STANDBY"],["14:34:15",3.763,26.559,"STANDBY"],["14:34:25",3.739,26.576,"STANDBY"],["14:34:30",3.793,26.515,"STANDBY"],["14:34:35",3.773,26.5,"STANDBY"],["14:34:45",3.743,26.567,"STANDBY"],["14:34:50",3.722,26.571,"STANDBY"],["14:34:55",3.684,26.558,"STANDBY"],["14:35:05",3.748,26.503,"STANDBY"],["14:35:10",3.792,26.58,"STANDBY"],["14:35:15",3.74,26.554,"STANDBY"],["14:35:25",3.767,26.477,"STANDBY"],["14:35:30",3.744,26.502,"STANDBY"],["14:35:35",3.726,26.42,"STANDBY"],["14:35:45",3.714,26.456,"STANDBY"],["14:35:50",3.796,26.453,"STANDBY"],["14:35:55",3.717,26.489,"STANDBY"],["14:36:05",3.719,26.558,"STANDBY"],["14:36:10",3.666,26.361,"STANDBY"],["14:36:15",3.722,26.45,"STANDBY"],["14:36:25",3.729,26.377,"STANDBY"],["14:36:30",3.752,26.549,"STANDBY"],["14:36:35",3.719,26.458,"STANDBY"],["14:36:45",3.743,26.514,"STANDBY"],["14:36:50",3.692,26.498,"STANDBY"],["14:36:55",3.758,26.434,"STANDBY"],["14:37:05",3.725,26.392,"STANDBY"],["14:37:10",3.724,26.447,"STANDBY"],["14:37:15",3.718,26.44,"STANDBY"],["14:37:25",3.669,26.507,"STANDBY"],["14:37:30",3.703,26.342,"STANDBY"],["14:37:35",3.729,26.4,"STANDBY"],["14:37:45",3.742,26.453,"STANDBY"],["14:37:50",3.771,26.457,"STANDBY"],["14:37:55",3.747,26.451,"STANDBY"],["14:38:05",3.66,26.39,"STANDBY"],["14:38:10",3.778,26.375,"STANDBY"],["14:38:15",3.743,26.432,"STANDBY"],["14:38:25",3.703,26.389,"STANDBY"],["14:38:30",3.757,26.325,"STANDBY"],["14:38:35",3.702,26.29,"STANDBY"],["14:38:45",3.735,26.325,"STANDBY"],["14:38:50",3.757,26.288,"STANDBY"],["14:38:55",3.757,26.238,"STANDBY"],["14:39:05",3.731,26.415,"STANDBY"],["14:39:10",3.723,26.397,"STANDBY"],["14:39:15",3.723,26.375,"STANDBY"],["14:39:25",3.76,26.34,"STANDBY"],["14:39:30",3.696,26.332,"STANDBY"],["14:39:35",3.759,26.386,"STANDBY"]];

  const HEALTHY = 1.17;      // healthy ON family, INC-0187 close-out
  const WARN = 26.5;         // EPS bus voltage warn
  const ONSET = 30;          // index of HEATER_B_ENABLE at 14:29:45
  const N = D.length;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const NS = "http://www.w3.org/2000/svg";
  const el = (n, a) => {
    const e = document.createElementNS(NS, n);
    for (const k in a) e.setAttribute(k, a[k]);
    return e;
  };

  // one geometry, shared by both panels, so the two strips stay in register
  const VW = 1000, X0 = 92, X1 = 948, Y0 = 18, Y1 = 96;
  const xAt = (i) => X0 + (i / (N - 1)) * (X1 - X0);

  function panel(host, cfg) {
    const svg = el("svg", {
      viewBox: `0 0 ${VW} ${cfg.height}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": cfg.aria,
    });
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const yAt = (v) => Y1 - ((v - cfg.min) / (cfg.max - cfg.min)) * (Y1 - Y0);

    const defs = el("defs");
    const grad = el("linearGradient", { id: cfg.gradId, x1: "0", y1: "0", x2: "0", y2: "1" });
    grad.append(
      el("stop", { offset: "0", class: `stop-${cfg.tone}-0` }),
      el("stop", { offset: "1", class: `stop-${cfg.tone}-1` })
    );
    defs.appendChild(grad);
    const clip = el("clipPath", { id: `clip-${cfg.gradId}` });
    clip.appendChild(el("rect", { x: 0, y: 0, width: VW, height: cfg.height }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    // baseline + labelled ticks — every label names a value the trace reaches
    for (const t of cfg.ticks) {
      const y = yAt(t.v);
      svg.appendChild(
        el("line", { x1: X0, x2: X1, y1: y, y2: y, class: t.ref ? "ref-line" : "grid-line" })
      );
      const lab = el("text", {
        x: X0 - 9,
        y: y + 3.2,
        "text-anchor": "end",
        class: "ax-label" + (t.ref ? " is-ref" : ""),
      });
      lab.textContent = t.label;
      svg.appendChild(lab);
    }

    // the command that starts it
    svg.appendChild(
      el("line", { x1: xAt(ONSET), x2: xAt(ONSET), y1: Y0 - 4, y2: Y1, class: "event-line" })
    );
    if (cfg.eventLabel) {
      const x = Math.min(xAt(ONSET) + 5, X1 - 52);
      const ev = el("text", { x, y: Y0 + 2, class: "event-label" });
      ev.textContent = cfg.eventLabel;
      svg.appendChild(ev);
    }

    const pts = D.map((r, i) => `${xAt(i).toFixed(1)},${yAt(r[cfg.col]).toFixed(1)}`);
    svg.appendChild(
      el("polygon", {
        points: `${X0},${Y1} ${pts.join(" ")} ${X1},${Y1}`,
        class: `fill-${cfg.tone}`,
        stroke: "none",
        "clip-path": `url(#clip-${cfg.gradId})`,
      })
    );

    const line = el("polyline", {
      points: pts.join(" "),
      class: `series series-${cfg.tone}`,
      "clip-path": `url(#clip-${cfg.gradId})`,
    });
    svg.appendChild(line);

    // last measured sample, emphasised
    const last = D[N - 1];
    svg.appendChild(
      el("circle", { cx: xAt(N - 1), cy: yAt(last[cfg.col]), r: 4, class: `end-dot dot-${cfg.tone}` })
    );

    if (cfg.xTicks) {
      for (const i of cfg.xTicks) {
        const t = el("text", { x: xAt(i), y: cfg.height - 8, "text-anchor": "middle", class: "ax-label" });
        t.textContent = D[i][0].slice(0, 5);
        svg.appendChild(t);
      }
    }

    const cursor = el("line", { x1: 0, x2: 0, y1: Y0 - 4, y2: Y1 + 4, class: "cursor-line" });
    const knob = el("circle", { cx: 0, cy: 0, r: 4.5, class: `cursor-dot dot-${cfg.tone}` });
    svg.append(cursor, knob);
    svg.appendChild(el("rect", { x: 0, y: 0, width: VW, height: cfg.height, class: "hit" }));

    if (!reduce) {
      const len = line.getTotalLength ? 2600 : 0;
      if (len) {
        line.style.strokeDasharray = String(len);
        line.style.strokeDashoffset = String(len);
        line.style.transition = "stroke-dashoffset 1.5s cubic-bezier(.22,.61,.36,1) .25s";
        requestAnimationFrame(() => (line.style.strokeDashoffset = "0"));
      }
    }

    host.appendChild(svg);
    return {
      svg,
      move(i) {
        const x = xAt(i);
        cursor.setAttribute("x1", x);
        cursor.setAttribute("x2", x);
        knob.setAttribute("cx", x);
        knob.setAttribute("cy", yAt(D[i][cfg.col]));
      },
    };
  }

  const heaterHost = document.getElementById("plotHeater");
  const busHost = document.getElementById("plotBus");

  if (heaterHost && busHost) {
    const heater = panel(heaterHost, {
      col: 1,
      tone: "hot",
      gradId: "gHot",
      height: 118,
      min: 0,
      max: 4.0,
      aria: "Heater B current holds near zero, then steps to about 3.8 amperes at 14:29:45 and stays there.",
      eventLabel: "HEATER_B",
      ticks: [
        { v: 0, label: "0" },
        { v: HEALTHY, label: "1.17×", ref: true },
        { v: 3.8, label: "3.8 A" },
      ],
    });

    const bus = panel(busHost, {
      col: 2,
      tone: "cool",
      gradId: "gCool",
      height: 140,
      min: 25.75,
      max: 28.75,
      aria: "Bus voltage sits near 28.4 volts, drops below the 26.5 volt warn line at 14:29:45 and keeps sagging to 26.24.",
      ticks: [
        { v: 26.24, label: "26.24" },
        { v: WARN, label: "26.50 warn", ref: true },
        { v: 28.51, label: "28.51" },
      ],
      xTicks: [0, 30, 57, 84, 111],
    });

    const out = {
      time: document.getElementById("roTime"),
      heat: document.getElementById("roHeat"),
      mult: document.getElementById("roMult"),
      bus: document.getElementById("roBus"),
      pay: document.getElementById("roPay"),
    };

    let at = -1;
    const paint = (i) => {
      i = Math.max(0, Math.min(N - 1, i));
      if (i === at) return;
      at = i;
      const r = D[i];
      heater.move(i);
      bus.move(i);
      out.time.textContent = r[0];
      out.heat.textContent = r[1].toFixed(3) + " A";
      out.mult.textContent = r[1] < 0.2 ? "— off" : (r[1] / HEALTHY).toFixed(1) + "×";
      out.bus.textContent = r[2].toFixed(3) + " V";
      out.pay.textContent = r[3];
    };

    // the page opens on the moment the command lands
    paint(ONSET);

    const tape = document.getElementById("tape");
    const track = (ev) => {
      const box = heater.svg.getBoundingClientRect();
      if (!box.width) return;
      const pad = (X0 / VW) * box.width;
      const span = ((X1 - X0) / VW) * box.width;
      paint(Math.round(((ev.clientX - box.left - pad) / span) * (N - 1)));
    };
    tape.addEventListener("pointermove", track);
    tape.addEventListener("pointerleave", () => paint(ONSET));
  }
})();
