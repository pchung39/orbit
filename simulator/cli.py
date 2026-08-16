"""Command-line entry for the Aurora-1 simulator."""

from __future__ import annotations

import argparse
from pathlib import Path

from simulator.scenarios import report_eps204, run_eps204, run_inc0187
from simulator.simulate import load_and_validate, run_simulation, summarize


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Aurora-1 telemetry simulator")
    parser.add_argument(
        "--scenario",
        choices=("nominal", "eps204", "fault1", "inc0187"),
        default=None,
        help="nominal | eps204 | fault1 (heater only) | inc0187 (prior-day source run)",
    )
    parser.add_argument("--days", type=float, default=0.0, help="nominal run length in days")
    parser.add_argument("--out", type=Path, default=None, help="CSV output path")
    parser.add_argument("--validate-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    spec = load_and_validate()
    scenario = args.scenario
    if args.validate_only or (scenario is None and args.days <= 0):
        print(f"mission: {spec['mission']['name']}")
        print(f"channels: {len(spec['channels'])}")
        print("spec ok")
        if not args.validate_only:
            print("pass --scenario nominal|eps204|fault1|inc0187 (and --days N for nominal)")
        return

    if scenario == "eps204":
        df = run_eps204(spec, with_science_mode=True)
        print(summarize(df, spec))
        print(report_eps204(df, spec))
        out = args.out or Path("runs") / "eps204.csv"
    elif scenario == "fault1":
        df = run_eps204(spec, with_science_mode=False)
        print(summarize(df, spec))
        print(report_eps204(df, spec))
        out = args.out or Path("runs") / "fault1.csv"
    elif scenario == "inc0187":
        df = run_inc0187(spec)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "inc0187.csv"
    else:
        duration_s = args.days * 86400.0 if args.days > 0 else 3 * 86400.0
        df = run_simulation(spec, duration_s=duration_s)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "nominal.csv"

    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    print(f"wrote {out}")
