<p align="center">
  <img src="docs/assets/orbit-logo.svg" width="96" alt="ORBIT" />
</p>

<h1 align="center">ORBIT</h1>

<p align="center">
  Investigation workbench for spacecraft anomaly response.<br />
  Seals a telemetry window, walks the named procedure, tags every claim,<br />
  and stops at a human decision.
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

Operators already have the alarm. What they need is a reviewable case: the same telemetry window every time, the procedure that governs the response, a prior that actually matches, and a recommendation that can be challenged.

ORBIT builds that case. It does not detect anomalies and it does not uplink commands.

**Demo spacecraft:** Aurora-1  
**Suggested path:** [`INC-0205`](http://127.0.0.1:8000/app/incidents/INC-0205) → [`INC-0210`](http://127.0.0.1:8000/app/incidents/INC-0210) → [Trust eval](http://127.0.0.1:8000/app/trust)

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
| 1 | **[INC-0205](http://127.0.0.1:8000/app/incidents/INC-0205)** | Heater-only fault → inhibit Heater B |
| 2 | **[INC-0210](http://127.0.0.1:8000/app/incidents/INC-0210)** | Same alarm shape, payload is the culprit → leave the heater alone |
| 3 | **[Trust → Eval](http://127.0.0.1:8000/app/trust)** | Release scorecard matches `python -m eval` |

| Case | Tape | Lesson |
|---|---|---|
| INC-0204 | eps204 | Heater fault + SCIENCE_MODE confounder |
| INC-0212 | marg001 | Loads below ≥2× → hold, do not invent a cause |
| INC-0211 | batt003 | Pack IR sag; healthy load currents |

## How it works

1. **Open a case** from an alarm, a UTC clock, and an archive tape.
2. **Seal a window.** ORBIT cuts warn ± padding from the tape CSV and writes `runs/sealed/{id}.csv` plus a small sidecar. Postgres stores only the case row.
3. **Investigate.** The rules investigator samples the sealed tape, reads the one named procedure (EPS-17, PAY-04, or EPS-09), and fetches the one named prior when the report cites it.
4. **Recommend.** Every claim is tagged. Filing records the assessment. Nothing is uplinked.

### Source tags

| Tag | Meaning |
|---|---|
| **OBSERVED** | In the sealed telemetry or command log |
| **DERIVED** | Computed from those measurements |
| **DOCUMENTED** | From a cited procedure step or prior close-out |
| **HYPOTHESIS** | Proposed cause — still open |

A plausible narrative is not a root cause until the procedure threshold is met (for example EPS-17 step 4: load ≥2× healthy ON).

### Product thesis

> Last command is not automatically the cause.

Heater B draws ~1.2 A when healthy and ~3.7 A when faulted. Two minutes later the payload enters SCIENCE_MODE and bus voltage crosses 26.5 V. The payload looks guilty — the heater was already wrong. ORBIT walks EPS-17, tags the evidence, and recommends inhibiting Heater B without sending the command.

## Architecture

ORBIT is a case workbench. The mission archive and the procedure book stay outside it.

```
Upstream archive          ORBIT                         Operator
─────────────────         ─────                         ────────
Tape CSV             →    Sealed window file
Named procedure file →    Case row in Postgres     →    Console / API
                          Rules investigator
                          Eval harness
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
  Report --> Decision[Human decision]
```

**What Postgres holds:** `incidents` and `hypothesis_feedback` — the case log.

**What stays on disk:** archive tapes under `runs/`, sealed windows under `runs/sealed/`, procedures under `procedures/`, authored priors under `incidents/`.

**What ORBIT does not keep:** a searchable document library, embeddings, or a copy of full-orbit telemetry in the database.

Interactive poster: [`docs/architecture.html`](docs/architecture.html)

### Console

| View | Route | Description |
|---|---|---|
| Overview | `/app` | Mission context and desk queue |
| Incidents | `/app/incidents` | Case log grouped by archive tape |
| Case | `/app/incidents/{id}` | Report, recommendation, procedure, evidence |
| Trust | `/app/trust` | Tape catalog, sealed snapshots, eval scorecard |

## Project structure

The mission spec is canonical: [`spec/aurora1_mission_model.yaml`](spec/aurora1_mission_model.yaml). If code and spec disagree, the spec wins.

```
orbit/
├── spec/                 Mission model — channels, limits, faults, scenarios
├── simulator/            Physics engine and scenario CSV generation
├── storage/              Case log, tape files, sealed windows
├── agent/                Investigator (rules | claude | openai) + tools
├── api/                  FastAPI server and static console routes
├── ui/                   Desk SPA (overview, incidents, case, trust)
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
python -m unittest eval.test_release_gate eval.test_explorer -v
```

**Release gate:** Trust reads `eval/scorecard.json` against `eval/baseline.json` (`PASS`, `BLOCKED`, or `INSUFFICIENT_COVERAGE`). A passing candidate does not overwrite the baseline — promotion is explicit.

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
| `GET` | `/api/incidents/{id}/workspace` | Sealed telemetry, events, channel limits |
| `POST` | `/api/incidents/{id}/investigate` | Rules investigation |
| `POST` | `/api/incidents/{id}/file` | File close-out |
| `GET` | `/api/runs` | Archive tapes + sealed windows |
| `GET` | `/api/trust` | Case-log health, tape catalog, eval snapshot |
| `GET` | `/api/eval/explorer` | Eval suite index |

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
