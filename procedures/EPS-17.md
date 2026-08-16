# EPS-17 — EPS low-voltage response

**Check recently activated nonessential loads**

| | |
|---|---|
| ID | EPS-17 |
| Applies to | Aurora-1 Electrical Power System |
| Entry | `EPS.bus_voltage` at or below warn (26.5 V) or critical (25.0 V) |
| Goal | Restore bus margin by finding the load that just came on — do not guess the payload first |

This procedure exists because a low-voltage alarm is a *symptom*. The last command that added load is the first place to look. A mode change in the same minute is not automatically the cause.

## Immediate actions

1. Confirm the alarm on `EPS.bus_voltage`. Note UTC time. **[OBSERVED]**
2. List commands and mode changes in the **10 minutes before** the first warn. **[OBSERVED]**
3. For each load that was enabled or raised in that window, read its current channel now vs its last healthy enable. **[OBSERVED / DERIVED]**

## Isolate the load

4. If a heater, payload, or other nonessential load is **well above its last healthy draw** (roughly 2× or more), that load is the prime suspect even if something else also turned on. **[DERIVED]**
5. A `SCIENCE_MODE` entry in the same window **raises bus current**, but payload current on Aurora-1 is < 1 A. It cannot by itself explain a several-amp step or a heater sitting at ~3× nominal. Do not close the investigation on the payload without checking heater current. **[DOCUMENTED — this procedure]**
6. Command the suspect nonessential load **OFF** (heater disable, or payload back to STANDBY) and watch `EPS.bus_voltage` recover. **[OBSERVED]**
7. If voltage recovers, leave that load off and open a fault report. If it does not, continue to battery/solar checkout (out of scope for this procedure).

## Expected vs not expected

| Channel | Healthy after HEATER_B_ENABLE | Treat as off-nominal |
|---|---|---|
| `THM.heater_b_current` | ~0.8–1.2 A | ≥ 2.0 A warn, ≥ 3.0 A critical |
| `PAY.payload_current` | ~0.08 A STANDBY, ~0.9 A SCIENCE | ≥ 1.1 A warn |
| `EPS.bus_current` | ~1.5–3 A typical | ≥ 6.0 A warn |

## Close-out

Record: first warn time, commands in the window, suspect load current vs last healthy enable, and whether inhibit restored the bus. Attach the similar-incident search result if one exists (see INC-0187).
