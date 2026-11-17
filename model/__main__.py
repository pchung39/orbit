"""python -m model calibrate   → learn the power model from history, write runs/models/eps.json"""

import json
import sys

from model.eps import calibrate


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] != "calibrate":
        print(__doc__)
        return
    r = calibrate()
    print(json.dumps({k: r[k] for k in ("params", "prior", "wear", "truth_check")}, indent=2))
    for ch, b in r["backtest"]["channels"].items():
        print(f"{b['label']:16} {b['hits']}/{b['total']} within {r['backtest']['tolerance_v']} V · mean error {b['mae']} V")
    for m in r["backtest"]["misses"]:
        print("  miss", round(m["t"] / 86400, 2), m["command"], m["EPS.bus_voltage"], m["why"])


if __name__ == "__main__":
    main()
