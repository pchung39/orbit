# PAY-04 — Payload power spike

**Safe SCIENCE_MODE if draw is ≥2× healthy**

| | |
|---|---|
| ID | PAY-04 |
| Applies to | Aurora-1 payload |
| Entry | `PAY.payload_current` at or above warn (1.1 A) or critical (1.3 A) |
| Goal | Confirm the payload itself is overcurrent — do not inhibit a healthy heater |

SCIENCE_MODE is supposed to raise payload current. The question is how far. Healthy science on Aurora-1 is ~0.9 A. A latch-up in the payload converter is ~2.7 A.

## Immediate actions

1. Confirm the alarm on `PAY.payload_current`. Note UTC time. **[OBSERVED]**
2. Confirm `PAY.mode` is `SCIENCE_MODE` and note when it entered. **[OBSERVED]**
3. Read payload current vs the healthy science baseline (~0.8–0.9 A). **[OBSERVED / DERIVED]**

## Isolate the load

4. If payload current is **≥2×** the 0.9 A science baseline, the payload is the prime suspect. **[DERIVED]**
5. Read `THM.heater_b_current`. If it is not ≥2× its healthy ON draw (~1.2 A), **do not inhibit Heater B**. A coincidental heater command is not this fault. **[DOCUMENTED — this procedure]**
6. Command the payload back to **STANDBY** and watch `PAY.payload_current` fall. **[OBSERVED]**
7. If current recovers, leave the payload in STANDBY and open a fault report. Do not uplink from ORBIT.

## Expected vs not expected

| Channel | Healthy SCIENCE_MODE | Treat as off-nominal |
|---|---|---|
| `PAY.payload_current` | ~0.9 A | ≥ 1.1 A warn, ≥ 1.3 A critical, ≥2× baseline is the close |
| `THM.heater_b_current` | 0 A if OFF, ~0.8–1.2 A if ON | ≥ 2.0 A — that is EPS-17, not this procedure |
| `EPS.bus_voltage` | usually still above 26.5 V | a bus sag here is a symptom, not the entry |

## Close-out

Record: first payload-current warn, SCIENCE_MODE time, payload current vs 0.9 A, heater current (to show it was not the load), and that safing was recommended not sent. Attach INC-0191 if the search returns it.
