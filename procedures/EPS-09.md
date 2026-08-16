# EPS-09 — Battery voltage sag

**Checkout pack IR before inhibiting loads**

| | |
|---|---|
| ID | EPS-09 |
| Applies to | Aurora-1 Electrical Power System — battery pack |
| Entry | `EPS.battery_voltage` at or below warn (25.5 V) or critical (24.5 V) |
| Goal | Decide whether the pack is sagging under a *healthy* load — do not inhibit that load |

A low battery terminal voltage looks like a load fault until you read the currents. If Heater B and the payload are in family, the pack's internal resistance is the next place to look. Bus voltage will follow the pack down; that is a symptom.

## Immediate actions

1. Confirm the alarm on `EPS.battery_voltage`. Note UTC time. **[OBSERVED]**
2. List commands in the **10 minutes before** the first warn. **[OBSERVED]**
3. Read `THM.heater_b_current` and `PAY.payload_current` at the warn. **[OBSERVED]**

## Isolate pack vs load

4. If a load is **≥2×** its healthy draw, stop this procedure and go to EPS-17 or PAY-04. **[DERIVED]**
5. If both heater and payload currents are healthy (heater ~0.8–1.2 A ON or ~0 A OFF; payload ~0.08 A STANDBY or ~0.9 A SCIENCE), **do not inhibit them**. The sag is on the pack. **[DOCUMENTED — this procedure]**
6. Note eclipse / `EPS.solar_array_current` ≈ 0 A. Discharge plus high IR is enough to nip 25.5 V. **[OBSERVED / DERIVED]**
7. Continue battery checkout (capacity, IR trend) offline. ORBIT does not command a heater inhibit or a payload safe from this procedure.

## Expected vs not expected

| Channel | Healthy under this entry | Treat as a different fault |
|---|---|---|
| `THM.heater_b_current` | ~0.8–1.2 A if just enabled | ≥ 2.0 A → EPS-17 |
| `PAY.payload_current` | ~0.08 A STANDBY / ~0.9 A SCIENCE | ≥ 1.1 A → PAY-04 |
| `EPS.battery_voltage` | 26.5–29.0 V | ≤ 25.5 V warn with healthy currents → this procedure |

## Close-out

Record: first battery-voltage warn, load currents (healthy), solar/eclipse, and that no inhibit was recommended. Attach INC-0162 if the search returns it.
