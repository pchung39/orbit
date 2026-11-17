<p align="center">
  <img src="docs/assets/orbit-logo.svg" width="96" alt="ORBIT" />
</p>

<h1 align="center">ORBIT</h1>

<p align="center">
  Anomaly response for spacecraft teams, from alarm to a decision you can check.<br />
  Seals a telemetry window, weighs every explanation against the procedure,<br />
  previews each option in a simulator replay, and verifies the operator's decision.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#demo">Demo</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#evaluation">Evaluation</a>
</p>

---

## Why ORBIT

Operators already have the alarm. What they need is a reviewable case: the same telemetry window every time, the procedure that governs the response, the explanations that were weighed and ruled out, a recommendation that can be challenged, and a check that the fix worked.

ORBIT builds that case and carries it through its lifecycle: **open → needs decision → verifying or watching → closed**. It does not detect anomalies and it does not uplink commands. Previews and verification run in a simulator and are labeled as such.

**Demo spacecraft:** Aurora-1  
**Suggested path:** [`INC-0204`](http://127.0.0.1:8000/app/incidents/INC-0204) → [`INC-0210`](http://127.0.0.1:8000/app/incidents/INC-0210) → [`INC-0212`](http://127.0.0.1:8000/app/incidents/INC-0212)

## Quick start

**Requirements:** Python 3.11+, Docker

```bash
git clone https://github.com/pchung39/orbit.git
cd orbit

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

docker compose up -d
python -m storage ingest

uvicorn api.app:app --host 127.0.0.1 --port 8000 --reload
```

| URL | What you get |
|---|---|
| [http://127.0.0.1:8000/](http://127.0.0.1:8000/) | Product landing |
| [http://127.0.0.1:8000/app](http://127.0.0.1:8000/app) | Operator console |
| [http://127.0.0.1:8000/about](http://127.0.0.1:8000/about) | Design decisions |
| `GET /health` | Health probe |

Local Postgres credentials live in `docker-compose.yml` (`orbit` / `orbit`) and are for development only.

Optional CLI keys (`.env`, not committed): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. The browser investigate path is always rules-based.

## Demo

| Step | Case | What to notice |
|---|---|---|
| 1 | **[INC-0204](http://127.0.0.1:8000/app/incidents/INC-0204)** | The payload looks guilty; *Which signal moved first* shows the heater led by 2 min. Open the replay: with a healthy heater there is no alarm. Approve *Turn off Heater B*, watch it verify, close. |
| 2 | **[INC-0210](http://127.0.0.1:8000/app/incidents/INC-0210)** | Payload is the culprit; the preview shows heater-off changes nothing |
| 3 | **[INC-0212](http://127.0.0.1:8000/app/incidents/INC-0212)** | No load clears the 2× bar → Hold; the case moves to *Watching* |

| Case | Tape | Lesson |
|---|---|---|
| INC-0205 | fault1 | Heater-only fault |
| INC-0211 | batt003 | Pack IR sag; healthy load currents → hold, continue EPS-09 |

The five demo cases reset each time the console loads, so the walkthrough can be replayed. Cases you open yourself are kept.

## How it works

1. **Open a case** from an alarm, a UTC clock, and an archive tape.
2. **Seal a window.** ORBIT cuts warn ± padding from the tape CSV and writes `runs/sealed/{id}.csv` plus a small sidecar. Postgres stores only the case row.
3. **Investigate.** The rules investigator samples the sealed tape, reads the one named procedure (EPS-17, PAY-04, or EPS-09), and fetches the one named prior when the report cites it. It produces a tagged markdown report (the eval artifact) and a structured **case brief**: facts, per-load attribution, which signal moved first, and heater / payload / battery explanations with evidence for and against.
4. **Prove it.** Every archive tape is a seeded simulator run, so ORBIT can replay the window with the suspect fault removed (*what-if*) and preview each option (turn off Heater B, safe the payload, hold) from a decision time.
5. **Decide → verify → close.** The operator approves an option; ORBIT records it and checks the simulated outcome against the procedure's recovery step. Hold moves the case to *Watching*. Nothing is uplinked.

Case lifecycle: `open → recommended (needs decision) → verifying | watching → filed (closed)`.

**Current limits**
- *Watching* is a status. Nothing re-checks a held case yet.
- Procedure bars (EPS-17's ≥2×, the 1.3× "elevated" floor) are encoded in `agent/hypothesis.py`, not read from the procedure files.
- Closed cases are not yet cited as priors. Only the three authored close-outs in `incidents/` are.
- Replays only exist for tapes with a recipe in `simulator/replay.py` (the five demo tapes). Other cases get the investigation without previews.

### Source tags

| Tag | Meaning |
|---|---|
| **OBSERVED** | In the sealed telemetry or command log |
| **DERIVED** | Computed from those measurements |
| **DOCUMENTED** | From a cited procedure step or prior close-out |
| **HYPOTHESIS** | Proposed cause — still open |
| **SIMULATED** | From a simulator replay of the sealed window, not from telemetry |

A plausible narrative is not a root cause until the procedure threshold is met (for example EPS-17 step 4: load ≥2× healthy ON).

### Product thesis

> Last command is not automatically the cause.

Heater B draws ~1.2 A when healthy and 3.74 A when faulted (3.1×). Two minutes later the payload enters SCIENCE_MODE and bus voltage crosses 26.5 V three seconds after that. The payload looks guilty — the heater was already wrong. ORBIT walks EPS-17, shows the heater moved first, rules out the payload and the battery with tagged evidence, and proves it: replayed with a healthy heater, the bus never crosses warn. It recommends turning off Heater B, previews that the bus recovers to 27.86 V, and lets the operator decide. Nothing is sent.

## Architecture

ORBIT is a case workbench. The mission archive and the procedure book stay outside it.

```
Upstream archive          ORBIT                               Operator
─────────────────         ─────                               ────────
Tape CSV             →    Sealed window file
Named procedure file →    Rules investigator → report + brief  →  Console / API
                          Simulator replay (what-if, previews) →  Decide
                          Case row in Postgres (decision, verify) ← approve / hold
                          Eval harness + unit tests
```

```mermaid
flowchart LR
  Archive[Archive tape CSV]
  Open[Open case]
  Seal[runs/sealed/*.csv]
  Case[incidents row]
  Proc[Named procedure file]

  Archive --> Open
  Open --> Seal --> Case
  Proc --> Investigate[Rules investigator]
  Case --> Investigate
  Investigate --> Report[Tagged report]
  Investigate --> Brief[Case brief]
  Brief --> Replay[Simulator replay]
  Replay --> Decision[Operator decision]
  Decision --> Verify[Simulated verification]
  Verify --> Case
```

- **Report** (`agent/investigate.py`): tagged markdown. It's what `python -m eval` scores, so its format is stable.
- **Case brief** (`agent/brief.py`): the same investigation as data. It holds facts, before/after load attribution, the order signals moved in, heater/payload/battery explanations with evidence for and against, the chart recipe, and the tool trail. Report and brief share one classifier (`agent/hypothesis.py`).
- **Replay** (`simulator/replay.py`): each archive tape is a seeded simulator run. Re-running its recipe reproduces the tape exactly. Removing the suspect fault gives the *what-if*. Adding `HEATER_B_DISABLE` or `PAYLOAD_STANDBY` at the decision time previews each option.

**What Postgres holds:** `incidents` (status, report, close-out, and the operator's decision with its simulated verification) and `hypothesis_feedback` (whether the decision agreed with ORBIT's recommendation). That's the case log.

**What stays on disk:** archive tapes under `runs/`, sealed windows under `runs/sealed/`, procedures under `procedures/`, authored priors under `incidents/`.

**What ORBIT does not keep:** a searchable document library, embeddings, or a copy of full-orbit telemetry in the database.

Interactive poster: [`docs/architecture.html`](docs/architecture.html)

### Console

| View | Route | Description |
|---|---|---|
| Overview | `/app` | Mission context and desk queue |
| Incidents | `/app/incidents` | Case log grouped by lifecycle stage (sidebar: Needs decision · Watching · Verifying · Closed) |
| Case | `/app/incidents/{id}` | What happened → competing explanations → decide (fix preview) → verify, plus the audit trail |

## Project structure

The mission spec is canonical: [`spec/aurora1_mission_model.yaml`](spec/aurora1_mission_model.yaml). If code and spec disagree, the spec wins.

```
orbit/
├── spec/                 Mission model — channels, limits, faults, scenarios
├── simulator/            Physics engine, scenario CSVs, what-if replay
├── storage/              Case log, tape files, sealed windows
├── agent/                Investigator (rules | claude | openai), case brief, tools
├── api/                  FastAPI server and static console routes
├── ui/                   Desk SPA (overview, incidents, case)
├── eval/                 Scorecard, baseline comparison, release gate
├── procedures/           EPS-17, PAY-04, EPS-09
├── incidents/            Authored prior close-outs (INC-0187, …)
├── runs/                 Archive CSVs + sealed/ windows
└── docs/                 Architecture poster, screenshots, assets
```

## CLI

```bash
# Storage — ensure tapes, case tables, demo incidents
python -m storage ingest
python -m storage channel fault1 THM.heater_b_current --from-clock 14:29:00 --to-clock 14:33:00
python -m storage events fault1

# Simulator
python -m simulator --validate-only
python -m simulator --scenario eps204 --out runs/eps204.csv

# Investigation — rules is free and deterministic
python -m agent investigate eps204 --provider rules
python -m agent investigate eps204                      # Claude, if ANTHROPIC_API_KEY is set

# Evaluation
python -m eval                                          # → eval/scorecard.json
python -m eval --compare-baseline
python -m eval --promote-baseline                       # explicit promotion only
```

`POST /api/incidents/{id}/investigate` always uses the rules provider.

## Evaluation

The harness scores finished reports against known close-outs.

| Metric | What it measures |
|---|---|
| **Named closes correct** | Heater / payload / battery cases fully passed |
| **Withheld when bar not met** | Decoy case refused to invent a root cause |
| **No false Heater B inhibit** | Contrast cases correctly leave the heater alone |
| **Source tags** | Provenance present; OBSERVED kept separate from HYPOTHESIS |

```bash
python -m eval
python -m unittest agent.test_brief simulator.test_replay eval.test_release_gate eval.test_explorer -v
```

**Release gate:** `python -m eval --compare-baseline` reads `eval/scorecard.json` against `eval/baseline.json` (`PASS`, `BLOCKED`, or `INSUFFICIENT_COVERAGE`). A passing candidate does not overwrite the baseline — promotion is explicit.

**Current rules scorecard:** 4/4 named closes · 1/1 withheld · 3/3 no false Heater B inhibit · 5/5 source tags clean

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres URL (default `postgresql://orbit:orbit@localhost:5432/orbit`) |
| `ANTHROPIC_API_KEY` | CLI Claude investigation (optional) |
| `OPENAI_API_KEY` | CLI OpenAI investigation (optional) |
| `LANGSMITH_API_KEY` | Trace investigations (optional) |
| `LANGSMITH_TRACING` | Set `true` to enable LangSmith |
| `LANGSMITH_PROJECT` | Project name (default: ORBIT) |
| `BRAINTRUST_API_KEY` | Tracing fallback if LangSmith is absent |

Do not commit `.env` files. With no tracing keys, tracing is a no-op.

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/incidents` | List incidents |
| `POST` | `/api/incidents` | Open case (alarm + tape → sealed file) |
| `GET` | `/api/incidents/{id}/workspace` | Sealed telemetry, events, channel limits, case brief |
| `POST` | `/api/incidents/{id}/investigate` | Rules investigation → report + case brief |
| `GET` | `/api/incidents/{id}/brief` | Case brief (null until investigated) |
| `POST` | `/api/incidents/{id}/decide` | Record a decision (`heater_off`, `payload_safe`, `hold`) and its simulated outcome |
| `POST` | `/api/incidents/{id}/file` | Close the case with a close-out |
| `GET` | `/api/runs` | Archive tapes + sealed windows |
| `GET` | `/api/archive` | Upstream tape catalog for opening a case |

## Development

```bash
# Screenshots (server must be running)
pip install playwright
playwright install chromium
python docs/capture_screenshots.py
```

Output lands in `docs/screenshots/`.

---

<p align="center">
  <sub>ORBIT · Aurora-1 · investigation workbench</sub>
</p>
