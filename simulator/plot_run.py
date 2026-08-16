"""Plot a simulator CSV so we can visually check it looks like a spacecraft bus."""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import yaml

from simulator.scenarios import clock_to_s
from simulator.simulate import SPEC_PATH

PANELS = (
    ("EPS.solar_array_current", "Solar array (A)"),
    ("EPS.bus_current", "Bus current (A)"),
    ("EPS.bus_voltage", "Bus voltage (V)"),
    ("EPS.battery_current", "Battery current (A)\n+ charge / − discharge"),
    ("soc_pct", "State of charge (%)"),
    ("THM.heater_b_current", "Heater B current (A)"),
    ("THM.battery_temperature", "Battery temp (°C)"),
    ("THM.heater_b_temperature", "Heater B temp (°C)"),
    ("PAY.payload_current", "Payload current (A)"),
)

WARN_LINES = {
    "EPS.bus_voltage": 26.5,
    "EPS.bus_current": 6.0,
}


def demo_event_hours() -> list[tuple[float, str]]:
    with SPEC_PATH.open() as f:
        spec = yaml.safe_load(f)
    marks = []
    for event in spec["demo_scenario_EPS204"]["script"]:
        marks.append((clock_to_s(event["t"]) / 3600.0, event["t"]))
    return marks


def plot_window(
    df: pd.DataFrame,
    title: str,
    out: Path,
    mark_demo: bool = False,
) -> None:
    fig, axes = plt.subplots(len(PANELS), 1, sharex=True, figsize=(11, 14))
    t_h = df["time_s"] / 3600.0
    marks = demo_event_hours() if mark_demo else []
    for ax, (col, ylabel) in zip(axes, PANELS):
        ax.plot(t_h, df[col], linewidth=0.8, color="0.15")
        if col in WARN_LINES:
            ax.axhline(WARN_LINES[col], color="C3", linestyle="--", linewidth=0.8, alpha=0.8)
        for hour, _label in marks:
            if t_h.min() <= hour <= t_h.max():
                ax.axvline(hour, color="C1", linestyle=":", linewidth=0.8, alpha=0.7)
        ax.set_ylabel(ylabel, fontsize=8)
        ax.grid(True, alpha=0.3)
        ax.tick_params(labelsize=8)
    axes[-1].set_xlabel("Time (hours from 00:00)")
    fig.suptitle(title, fontsize=12)
    fig.tight_layout()
    fig.savefig(out, dpi=120)
    plt.close(fig)


def zoom_slice(df: pd.DataFrame) -> pd.DataFrame:
    """Window around the heater turning on, or the first two orbits."""
    jump = df["THM.heater_b_current"].diff()
    if jump.max() > 1.0:
        center = df.loc[jump.idxmax(), "time_s"]
        return df[(df["time_s"] >= center - 8 * 60) & (df["time_s"] <= center + 12 * 60)]
    t0 = df["time_s"].iloc[0]
    return df[df["time_s"] < t0 + 2 * 96 * 60]


def main() -> None:
    parser = argparse.ArgumentParser(description="Plot Aurora-1 simulator output")
    parser.add_argument("csv", type=Path, nargs="?", default=Path("runs/nominal.csv"))
    parser.add_argument("--out-dir", type=Path, default=Path("runs"))
    parser.add_argument("--mark-demo", action="store_true", help="draw EPS-204 script times")
    args = parser.parse_args()

    df = pd.read_csv(args.csv)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.csv.stem
    mark = args.mark_demo or stem in {"eps204", "fault1"}

    plot_window(df, f"{stem} — full run", args.out_dir / f"{stem}_full.png", mark_demo=mark)
    zoom = zoom_slice(df)
    plot_window(df if zoom.empty else zoom, f"{stem} — zoom", args.out_dir / f"{stem}_zoom.png", mark_demo=mark)
    print(f"wrote {args.out_dir / f'{stem}_full.png'}")
    print(f"wrote {args.out_dir / f'{stem}_zoom.png'}")


if __name__ == "__main__":
    main()
