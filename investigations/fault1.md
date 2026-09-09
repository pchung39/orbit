# Investigation fault1

- **Entry:** `EPS.bus_voltage` warn (limit 26.5 V)
- **Procedure:** EPS-17
- **Scope:** assemble evidence and recommend a human decision. Does not command the spacecraft.

## Timeline

1. `EPS.bus_voltage` first crossed warn at **14:33:05** (26.494 V). **[OBSERVED]**
2. Commands / mode changes in the 10 minutes before that. **[OBSERVED]**
   - 14:29:44 `HEATER_B_ENABLE` on `THM.heater_b_current`
3. At `HEATER_B_ENABLE` (14:29:44), `THM.heater_b_current` = **3.74 A**. Healthy ON range is 0.8–1.2 A. **[OBSERVED / DOCUMENTED]**
4. That is **3.1×** the healthy-max draw. EPS-17 treats ≥2× as the prime suspect. **[DERIVED]**
5. `PAY.mode` = STANDBY, `PAY.payload_current` = **0.10 A**. **[OBSERVED]**
6. At the warn, `EPS.bus_current` = **5.33 A**. **[OBSERVED]**
7. `EPS.battery_voltage` = **28.60 V** (warn 25.5 V). **[OBSERVED]**
8. `THM.heater_b_temperature` = **42.7 °C** at the warn (nominal 10–20 °C, warn 40 °C). **[OBSERVED]**
9. Prior incident **INC-0187**. Prior heater current after enable was **3.72 A** — same signature, payload stayed STANDBY. **[DOCUMENTED / OBSERVED]**

## Hypothesis

**HEATER_B_OVERCURRENT** (FAULT-001): Heater B draws ~3× when commanded ON. Payload stayed STANDBY. **[HYPOTHESIS]**

## Recommended human decision

Inhibit Heater B and watch `EPS.bus_voltage` recover (EPS-17 step 6). Do **not** safe the payload first. **[HYPOTHESIS — not executed]**

ORBIT stops here. An operator has to send the command.

## Tool log

- first_warn fault1 EPS.bus_voltage limit=26.5 below → 14:33:05 26.494
- events fault1 in 14:23:05–14:33:05 → 1
- sample fault1 THM.heater_b_current @ 14:33:05 → 14:33:05 3.726
- sample fault1 PAY.payload_current @ 14:33:05 → 14:33:05 0.096
- sample fault1 PAY.mode @ 14:33:05 → 14:33:05 STANDBY
- sample fault1 EPS.bus_current @ 14:33:05 → 14:33:05 5.331
- sample fault1 THM.heater_b_temperature @ 14:33:05 → 14:33:05 42.666
- sample fault1 EPS.battery_voltage @ 14:33:05 → 14:33:05 28.601
- sample fault1 THM.heater_b_current @ 14:29:44 → 14:29:45 3.739
- get_doc EPS-17 → hit
- search_docs 'heater overcurrent' → ['INC-0187:0.73', 'INC-0191:0.67', 'EPS-17:0.62', 'INC-0162:0.61', 'PAY-04:0.61', 'EPS-09:0.59']
- get_doc INC-0187 → hit
- get_doc INC-0191 → hit
- get_doc INC-0162 → hit
- sample inc0187 THM.heater_b_current @ 01:52:00 → 01:52:00 3.718
