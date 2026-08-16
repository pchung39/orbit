"""Command-line entry for the Aurora-1 simulator."""

from __future__ import annotations

import argparse
from pathlib import Path

from simulator.scenarios import (
    report_eps204,
    run_batt003,
    run_eps204,
    run_inc0162,
    run_inc0187,
    run_inc0191,
    run_nominal_slice,
    run_pay002,
)
from simulator.simulate import load_and_validate, run_simulation, summarize


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Aurora-1 telemetry simulator")
    parser.add_argument(
        "--scenario",
        choices=(
            "nominal",
            "eps204",
            "fault1",
            "inc0187",
            "pay002",
            "inc0191",
            "batt003",
            "inc0162",
        ),
        default=None,
        help="named tape, or --days N for a long nominal run",
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
            print("pass --scenario <name> (and --days N for a long nominal run)")
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
    elif scenario == "pay002":
        df = run_pay002(spec)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "pay002.csv"
    elif scenario == "inc0191":
        df = run_inc0191(spec)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "inc0191.csv"
    elif scenario == "batt003":
        df = run_batt003(spec)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "batt003.csv"
    elif scenario == "inc0162":
        df = run_inc0162(spec)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "inc0162.csv"
    elif scenario == "nominal":
        df = run_nominal_slice(spec)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "nominal.csv"
    else:
        duration_s = args.days * 86400.0 if args.days > 0 else 3 * 86400.0
        df = run_simulation(spec, duration_s=duration_s)
        print(summarize(df, spec))
        out = args.out or Path("runs") / "nominal.csv"

    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(out, index=False)
    print(f"wrote {out}")
