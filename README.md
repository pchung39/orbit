<p align="center">
  <img src="docs/assets/orbit-logo.svg" width="120" alt="ORBIT" />
</p>

<h1 align="center">ORBIT</h1>

<p align="center">
  <strong>An operator already has an alarm.</strong><br />
  ORBIT assembles the tape, the last commands, the procedure, and a similar prior incident<br />
  so a human can decide why — then it stops.
</p>

<p align="center">
  <img src="docs/screenshots/overview-dark.png" alt="ORBIT overview — Aurora-1 telemetry dashboard with channel tiles, orbit map, and posture assessment" width="920" />
</p>

<p align="center">
  <em>Demo spacecraft: <strong>Aurora-1</strong> · Canonical case: <strong>INC-0204</strong> (EPS-204)</em>
</p>

---

ORBIT does **not** detect anomalies. It does **not** command the spacecraft.

It starts after detection and stops at a human decision. Filing records the close; it still does not send the command.

## The case

Healthy Heater B draws ~1.2 A when ON. The fault draws ~3.7 A — about 3×.

Two minutes later the payload enters `SCIENCE_MODE`. Bus voltage nips the 26.5 V warn. Bus current hits 6 A. The payload looks guilty.

The heater was already wrong.

**Recommend inhibit Heater B. Do not send the command.**

That confounder is the whole point. Last command is not automatically the cause.

## What you get

1. **Overview** — last samples on any ingested tape, orbit context, limit-margin meters, and a posture readout before you open a case.
2. **Incidents** — a case queue with craft-level signatures: what recurs on Aurora-1, and what filed cases actually closed on.
3. **Case walkthrough** — evidence, commands, tape, procedure, tagged report, and decision — with a sticky spine so you always know where you are.
4. **Library** — its own tab. Semantic search, kind and signature filters, and a reading column for procedures and close-outs. Press `/` or ⌘K.
5. **Trust** — data-plane health: ingested tapes, library embeddings, investigator mode, product boundaries, and links into Overview / Library / Incidents.
6. **Provenance** — every claim in the report is stamped **OBSERVED**, **DERIVED**, **DOCUMENTED**, or **HYPOTHESIS**.

The UI uses a deterministic rules path. No paid model in the browser.

<p align="center">
  <img src="docs/screenshots/incidents-dark.png" alt="Incidents dashboard with case table, filter bar, and craft signature rail" width="920" />
</p>

<p align="center">
  <img src="docs/screenshots/library-dark.png" alt="Library tab with search, category filters, document index, and a reading column for EPS-17" width="920" />
</p>

## Console (v0.5)

| View | What it shows |
|---|---|
| **Overview** | Tape picker, channel tiles with sparklines and margin meters, orbit map (sun at focus), command log, posture chip |
| **Incidents** | Filterable case table, clickable stat filters, **Next up** queue, **Signatures** precedent rail |
| **Case** | Six-step spine, compare grid, command timeline, shared-axis traces, procedure satisfaction, tagged report, file decision |
| **Library** | Full-page book: `/` search, kind + signature filters, index + reading column; close-outs and procedures open here |
| **Trust** | Store + library status, product boundaries, tape catalog (span / sample counts), **Inspect** opens sample-level verification |
| **Theme** | Dark default, light optional — hero and incidents header stay night-side in both |

<p align="center">
  <img src="docs/screenshots/overview-light.png" alt="ORBIT overview in light theme" width="920" />
</p>

## Run the demo

Python 3.11+ and Docker (Postgres + pgvector).

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

docker compose up -d
python -m storage ingest

uvicorn api.app:app --host 127.0.0.1 --port 8000 --reload
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/).

**Start here:** Overview → Incidents → open **INC-0204** (heater + confounder). Also try **INC-0205** (heater only), **INC-0210** (payload guilty), **INC-0211** (pack IR).

Open **Trust** (tab or the **AURORA-1** chip) to verify the telemetry store and library index before you rely on a case.

Local DB is `orbit` / `orbit` in `docker-compose.yml` — not a production secret. `.env` is for optional CLI keys only; do not commit it.

### Peek at raw telemetry

**Tape inspector** (UI): **Trust → Inspect** on any tape, or **Inspect samples** on Case → Tape. Shows sample rows and events for a scoped window (warn ± 8 min or full run). Highlights first warn crossing and pinned time.

CLI/API for scripts:

```bash
python -m storage channel eps204 THM.heater_b_current --from-clock 14:29:00 --to-clock 14:33:00
python -m storage events eps204
```

HTTP: `GET /runs/{run_id}/inspect?channel=&alarm=&window=focus|full`, plus channel/events routes.

### Regenerate screenshots

With the server running:

```bash
pip install playwright
playwright install chromium
python docs/capture_screenshots.py
```

## How it's built

The spec is canonical: [`spec/aurora1_mission_model.yaml`](spec/aurora1_mission_model.yaml). If code and spec disagree, the spec wins.

| Piece | Role |
|---|---|
| Spec | Channels, limits, faults, the story the rest of the stack must tell |
| Simulator | Nominal + EPS-204 + fault1 + INC-0187 + PAY-002 + INC-0191 + BATT-003 + INC-0162 |
| Store | Postgres / pgvector — runs, telemetry, events, procedures, open incidents |
| Agent | Tools over the store; `--provider rules` in the UI; Claude/OpenAI CLI-only |
| Console | FastAPI + instrument UI at `/` |
| Trust API | `GET /trust` — store, library, and investigator health for the Trust tab |
| Eval | 4 cases against the matching close (heater, payload, battery) |

```
spec/aurora1_mission_model.yaml
simulator/          physics + scenarios
storage/            ingest, query, local embeddings, trust snapshot
agent/              investigate (rules | claude | openai)
api/                HTTP + static console (/trust, /desk, …)
ui/                 overview, incidents, case, library, trust
procedures/         EPS-17, PAY-04, EPS-09
incidents/          INC-0187, INC-0191, INC-0162
eval/
```

## Eval

Scores a finished report against the matching close. Heater cases still require inhibit Heater B and (on EPS-204) SCIENCE_MODE as a confounder. Payload and battery cases fail any rules path that always blames the heater.

```bash
python -m eval
```

Default is `--provider rules` (no paid LLM). Green on this harness is the bar: 4 cases.

## Optional: simulator and LLM CLI

Regenerate tapes:

```bash
python -m simulator --validate-only
python -m simulator --scenario eps204 --out runs/eps204.csv
python -m simulator --scenario pay002 --out runs/pay002.csv
python -m simulator --scenario batt003 --out runs/batt003.csv
```

Paid models are CLI-only. Copy `.env.example` to `.env` if you want them.

```bash
python -m agent investigate eps204 --provider rules
python -m agent investigate eps204              # Claude, if ANTHROPIC_API_KEY is set
```

The HTTP investigate route always uses rules. It will not call Anthropic or OpenAI.

## Not this

- Anomaly detection or live vehicle
- Command uplink

---

<p align="center">
  <img src="docs/assets/orbit-mark.svg" width="28" alt="" />
  &nbsp; ORBIT · Aurora-1 · v0.5
</p>
