# ORBIT

An operator already has an alarm. ORBIT assembles the tape, the last commands, the procedure, and a similar prior incident so a human can decide why — then it stops.

It does **not** detect anomalies. It does **not** command the spacecraft.

Demo spacecraft: **Aurora-1** (fictional, internally coherent). Canonical case: **EPS-204**.

---

## The case

Healthy Heater B draws ~1.2 A when ON. The fault draws ~3.7 A — about 3×.

Two minutes later the payload enters `SCIENCE_MODE`. Bus voltage nips the 26.5 V warn. Bus current hits 6 A. The payload looks guilty.

The heater was already wrong.

**Recommend inhibit Heater B. Do not send the command.**

That confounder is the whole point. Last command is not automatically the cause.

## What you get

1. Open an incident from an alarm you already have — tape + entry channel. ORBIT does not invent the warn.
2. See loads at the first warn, commands in the prior 10 minutes, and traces pinned to that clock.
3. Walk **EPS-17** (low-voltage response). Evidence already on the page is marked Satisfied. Step 6 stays **Not sent**.
4. Assemble a tagged report. Every claim is **OBSERVED**, **DERIVED**, **DOCUMENTED**, or **HYPOTHESIS**.

The UI uses a deterministic rules path. No paid model in the browser.

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

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/). Seed incident is **INC-0204**.

Local DB is `orbit` / `orbit` in `docker-compose.yml` — not a production secret. `.env` is for optional CLI keys only; do not commit it.

## How it's built

The spec is canonical: [`spec/aurora1_mission_model.yaml`](spec/aurora1_mission_model.yaml). If code and spec disagree, the spec wins. Mismatches are flagged in comments, not patched over.

| Piece | Role |
|---|---|
| Spec | Channels, limits, faults, the story the rest of the stack must tell |
| Simulator | Nominal + EPS-204 (heater + SCIENCE_MODE) + fault1 (heater only) + INC-0187 |
| Store | Postgres / pgvector — runs, telemetry, events, procedures, open incidents |
| Agent | Tools over the store; `--provider rules` in the UI; Claude/OpenAI CLI-only |
| Console | FastAPI + a light ops UI at `/` |
| Eval | 2 cases × 9 checks against the EPS-17 close |

```
spec/aurora1_mission_model.yaml
simulator/          physics + scenarios
storage/            ingest, query, local embeddings
agent/              investigate (rules | claude | openai)
api/                HTTP + static console
ui/                 incidents, traces, procedure, report
procedures/EPS-17.md
incidents/INC-0187.md
eval/
```

## Eval

Scores a finished report: cite the heater current, treat SCIENCE_MODE as a confounder on EPS-204 (and do not invent it on fault1), recommend inhibit Heater B, stop without commanding, tag every claim.

```bash
python -m eval
```

Default is `--provider rules` (no paid LLM). Green on this harness is the MVP bar.

## Optional: simulator and LLM CLI

Regenerate tapes:

```bash
python -m simulator --validate-only
python -m simulator --scenario eps204 --out runs/eps204.csv
python -m simulator --scenario fault1 --out runs/fault1.csv
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
- Filing an open incident back into the library (next)
- A contrast case where the payload *is* guilty (next)

ORBIT starts after detection and stops at a human decision.
