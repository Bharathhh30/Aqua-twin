# AquaTwin — Architecture and Implementation Handoff

## Project understanding

AquaTwin is a **software-only predictive-maintenance demonstration** for domestic RO purifiers. Synthetic sensors produce correlated readings; a separate edge simulator validates and summarizes them; MQTT carries telemetry to a backend; analytics estimate stage health, remaining life, and likely faults; and the application presents those results and coordinates a simulated replacement workflow.

The demo should be **operational and repeatable, not a dashboard of hardcoded values**. Sensor data and model results must be labelled synthetic—not presented as field-validated performance.

The workspace includes `project.pdf`. It supports the core proposal: household RO health indicators, an edge Kalman filter, cloud particle-filter forecasts and fault classification, source-change detection, and an advisory system that leaves safety interlocks unchanged. It also gives illustrative device parameters and targets. For this software demo, the PDF’s proposed physical membrane swap and O-ring test should become deterministic fault injections in the simulator.

## 1. Technical architecture

```text
                     CONTROL / SCENARIO PATH
 React dashboard ──REST──> FastAPI control API ──MQTT command──> Edge simulator
       │                                                         │
       │                                                         ▼
       │                                            Synthetic sensor engine
       │                                            + steady-state processing
       │                                                         │
       │                                                         ▼
       │                                                  MQTT telemetry
       │                                                         │
       ▼                                                         ▼
 REST / SSE <── FastAPI API <── analytics worker <── MQTT subscriber
                       │              │
                       └──────────────┴──────────> PostgreSQL / TimescaleDB
                                      │
                                      └── health, forecasts, alerts,
                                          source-change events,
                                          replacement and dispatch workflow
```

The sensor generator, edge processor, broker, backend, analytics, database, and frontend should remain distinct **logical components**. For the first implementation, they can run as a small set of Docker Compose processes rather than as many independently deployed services.

A useful boundary is:

- **Device/edge:** 1 Hz synthetic readings while the pump runs, validation, stable-operation filtering, temperature correction, health indicators, and EKF.
- **Cloud ingestion:** MQTT subscription, schema validation, deduplication, and persistence.
- **Cloud analytics:** filter health, forecasts, fault classification, and source-change detection.
- **Application/service layer:** dashboard APIs, simulation controls, recommendations, inventory, serviceability, and dispatch.
- **Safety simulation:** independent lockout logic; predictions cannot override the simulated output-TDS, UV, leak, or dry-run interlocks.

## 2. Proposed repository structure

```text
/
├─ README.md
├─ compose.yaml
├─ config/
│  ├─ devices.yaml
│  ├─ simulation.yaml
│  └─ scenarios/hyderabad-tanker-fouling.yaml
├─ contracts/
│  ├─ raw-reading.v1.schema.json
│  ├─ edge-telemetry.v1.schema.json
│  ├─ command.v1.schema.json
│  ├─ prediction.v1.schema.json
│  └─ service-request.v1.schema.json
├─ infra/
│  ├─ mosquitto/
│  └─ database/
│     └─ migrations/
├─ services/
│  ├─ simulator/
│  │  └─ aquatwin_sim/{sensor,plant,edge,commands,clock}.py
│  └─ backend/
│     └─ aquatwin/
│        ├─ api/
│        ├─ ingestion/
│        ├─ domain/
│        ├─ analytics/
│        ├─ repositories/
│        └─ workflows/
├─ apps/
│  └─ web/
├─ tests/
│  ├─ contracts/
│  ├─ simulator/
│  ├─ analytics/
│  └─ end_to_end/
└─ docs/
   ├─ architecture.md
   ├─ assumptions-and-calibration.md
   └─ demo-runbook.md
```

This is a monorepo with clear module boundaries—not a recommendation to start with microservices.

## 3. Component responsibilities

| Component | Responsibility |
|---|---|
| **Sensor/plant simulator** | Generate time-dependent purifier readings, noise, unstable cycles, degradation, sensor faults, and injected faults. |
| **Edge simulator** | Validate readings; flag bad or unstable data; retain steady-state measurements; calculate indicators; update EKF; publish summaries and device events. |
| **Mosquitto** | Provide real MQTT publish/subscribe transport. It does not analyze telemetry. |
| **MQTT subscriber/ingestion** | Validate versioned messages, handle retries and duplicate delivery, and persist accepted telemetry. |
| **Analytics** | Update filter-specific health, forecast remaining life, classify likely faults, and detect source changes. |
| **FastAPI backend** | Provide device, telemetry, prediction, alert, and service APIs; own simulation controls and workflow transitions. |
| **TimescaleDB** | Store time-indexed telemetry and events alongside relational device, prediction, inventory, and dispatch records. |
| **React application** | Render backend-derived readings and analytics; send scenario controls to the actual simulator/backend. |
| **Service workflow** | Apply recommendation/approval, SKU selection, inventory, pincode serviceability, dispatch, delivery, and completion rules. |

## 4. Data contracts

All externally exchanged messages should be versioned, timestamped in UTC, validated against schemas, and tied to a device or request ID. Use explicit units in field names.

### Raw reading

Internal 1 Hz edge input:

```json
{
  "schema_version": "raw-reading.v1",
  "device_id": "AQT-1001",
  "sequence": 18420,
  "timestamp": "2026-11-04T10:00:00Z",
  "pump_on": true,
  "pump_runtime_s": 95,
  "valve_state": "purifying",
  "tank_float_state": "filling",
  "input_tds_ppm": 650,
  "output_tds_ppm": 35,
  "water_temp_c": 28,
  "inlet_pressure_mpa": null,
  "ro_pressure_mpa": null,
  "reject_flow_lpm": null,
  "pump_current_ma": null,
  "uv_current_ma": null
}
```

Optional-kit signals are nullable; their absence must not be interpreted as zero.

### Edge telemetry

Cloud-facing processed summary:

```json
{
  "schema_version": "edge-telemetry.v1",
  "device_id": "AQT-1001",
  "sequence": 18420,
  "timestamp": "2026-11-04T10:00:00Z",
  "operating_state": "steady",
  "quality": {
    "readings_valid": true,
    "sensor_faults": [],
    "steady_state_duration_s": 34
  },
  "measurements": {
    "input_tds_ppm": 650,
    "output_tds_ppm": 35,
    "water_temp_c": 28,
    "tank_fill_time_min": 38
  },
  "indicators": {
    "tcf": 1.0,
    "normalized_permeate_flow": null,
    "salt_passage": 0.0538
  },
  "edge_state": {
    "estimated_fouling_resistance": null,
    "estimated_fouling_growth_rate": null,
    "estimated_tds_offset_ppm": null
  }
}
```

The `null` indicator values above are intentional examples: they should be unavailable until required reference/calibration parameters have been configured. Production schemas should define which fields are required for each operating state.

Also define versioned contracts for:

- **Simulation command/acknowledgement:** command ID, device ID, action, parameters, issue time, result, and correlation ID.
- **Prediction:** device/stage, model version, P10/P50/P90 remaining life, prediction timestamp, evidence window, and configured end-of-life basis.
- **Fault event:** category, severity, probability, supporting indicators, sensor-quality context, and detection time.
- **Replacement/service request:** prediction reference, SKU, approval and service statuses, inventory result, serviceability result, dispatch ID, and timestamps.

## 5. MQTT communication design

Proposed topic conventions:

```text
aquatwin/v1/devices/{device_id}/telemetry
aquatwin/v1/devices/{device_id}/events
aquatwin/v1/devices/{device_id}/commands
aquatwin/v1/devices/{device_id}/command-acks
aquatwin/v1/devices/{device_id}/status
```

Telemetry flows **edge → broker → backend subscriber**. Commands flow **control API → broker → edge simulator**, with an acknowledgement back to the API/backend. Use QoS 1 for important telemetry, commands, and events; commands should be idempotent and correlated to acknowledgements. Configure a Last Will/status message and reconnection handling.

The PDF describes 1 Hz **local sampling** and roughly 2 KB/day of summarized transmission. Those are different rates. For the demo, internal readings can be frequent while MQTT publishes cycle summaries and fault events; a configurable higher cloud update rate can support a live dashboard. The demo’s chosen cadence should be documented rather than represented as meeting the 2 KB/day target.

## 6. Database proposal

Use PostgreSQL with TimescaleDB. Keep time-series and workflow data related but logically separated.

- **devices:** device/customer identifiers, pincode, installation/model metadata, status, source-profile inference.
- **telemetry:** timestamp, device, sequence, operating/quality state, sensor values, derived indicators. Make this a hypertable; deduplicate on device and sequence.
- **filter_health:** device, stage, health state, estimator values, update time.
- **predictions:** device, stage, P10/P50/P90, failure window, likely cause, model version, evidence range.
- **alerts / fault_events:** category, severity, indicators, acknowledgement state, timestamp.
- **source_change_events:** change time, prior/new inferred profile, confidence, supporting feed measurements.
- **simulation_runs:** scenario ID, deterministic seed, simulation clock/rate, run status.
- **replacement_requests:** customer/device, stage, SKU, prediction reference, approval and service state.
- **inventory:** SKU, location, quantity/status.
- **dispatches:** request, pincode, serviceability, assigned team, tracking status, event timestamps.

Pincode-based model priors and dispatch serviceability should be separate modules and separate data paths. Do not use raw household readings as shared fleet data.

## 7. Predictive analytics strategy

1. **Edge indicators:** Implement the supplied TCF formula, which is 1 at 25 °C. Calculate salt passage only when input TDS is valid and nonzero. Compute NPF only when permeate flow and the current/reference NDP inputs are available.
2. **Flow and NDP model:** Infer flow from tank volume and fill time using configured usable volume and fill-state assumptions. Make the NDP calculation explicit and configurable; pressure alone may not provide the osmotic-pressure correction needed for a physically meaningful RO NDP.
3. **Three-state EKF:** Estimate fouling resistance, its growth rate, and TDS sensor offset from flow and salt-passage observations. Keep state units, transition/observation equations, initial covariance, and process/measurement noise in configuration. Update it only from valid steady-state observations.
4. **Particle filter:** Run the configured forecast job on the last 14 simulated days of usage. The proposed ~500 particles can project degradation to configured stage-specific EOL criteria and yield P10/P50/P90 life estimates. Treat those as simulation forecasts, not validated accuracy.
5. **Fault classifier:** Train a gradient-boosted classifier on synthetic, labelled scenarios for the six specified fault classes. Split validation by scenario/run—not randomly by individual rows—to reduce leakage. Show class probabilities and supporting indicators, and identify the model as synthetic.
6. **Source-change detection:** Apply Bayesian change-point detection to feed TDS level/variation and temperature. Report a *potential* profile change and confidence; do not claim that TDS alone proves a source.
7. **Health and replacement:** Maintain per-stage status. Some stages have only indirect indicators in the base signal set—for example carbon exhaustion is an estimate from volume/source assumptions, while UV health may rely on burn hours unless current sensing is enabled. Use stage-specific configured limits and manufacturer maximum-life rules, not a universal arbitrary health percentage.
8. **Sensor faults and safety:** Quality/fault checks precede degradation analytics. A stuck or inconsistent sensor should trigger degraded confidence and the configured fallback counter logic, not an automatic cartridge fault. Safety lockouts remain independent of prediction and cannot be overridden.

## 8. Repeatable simulation scenario

Use a named scenario file and fixed random seed for reproducibility:

1. **Healthy start:** AQT-1001, Hyderabad, municipal profile; steady operation and baseline filter states.
2. **Source switch:** Change to a synthetic tanker profile. Feed TDS and variability change; the detector reports an inferred profile change with uncertainty.
3. **Gradual RO fouling:** Decrease permeate performance and increase salt passage according to configured simulation dynamics; the edge EKF updates only from steady, valid readings.
4. **Forecast and recommendation:** Advance simulation time; the backend produces a life range, cause evidence, alert, and replacement recommendation when configured criteria are met.
5. **Dispatch workflow:** Approve the request; verify cartridge stock and pincode serviceability; create dispatch; advance delivery status; mark replacement complete.
6. **Separate bypass demonstration:** Inject an O-ring/bypass fault and show a sudden salt-passage change, fault alert, and unchanged independent safety logic.
7. **Additional controls:** Sediment clog, pump wear, UV ageing, and individual sensor failure should each alter the simulator’s state and resulting backend outputs—not just dashboard labels.

## 9. Assumptions and parameters to settle

No physical calibration constants, validated model accuracy, or real-world sensor behaviour should be silently invented. Put demo assumptions in `config/simulation.yaml` and label them as synthetic. Parameters still needed include:

- Reference NDP, the pressure/osmotic model, and the baseline permeate-flow convention.
- Usable tank volume and how float-switch transitions define fill duration.
- Stage-specific EOL criteria, output-water limits, and applicable manufacturer maximum-life settings.
- Synthetic source profiles and their distributions/correlation; source labels are simulator ground truth, not proof of real source identification.
- Sensor noise, operating ranges, stuck/drift/outlier rules, and fault dynamics.
- EKF model, initialization, and covariance settings; degradation-process assumptions and particle-filter noise.
- Classifier training scenarios and synthetic evaluation method.
- Cloud publish cadence versus the PDF’s approximate 2 KB/day target.
- Demo customer/device/service records, inventory, and serviceable pincodes.

The PDF supplies useful reference points: pump pressure around 0.4–0.7 MPa; optional pressure sensors specified as 0–1.2 MPa, ±1% full scale; and an 8 L tank fill example of 25–40 minutes. It also states targets such as a 14-day warning and 85% fault-cause accuracy, but these are **project targets, not achieved results**. They should not be treated as calibration data or claims about the synthetic demo.

## 10. Incremental implementation plan

1. **Foundation:** Add repository documentation and schemas; define configuration and scenario formats; start Mosquitto and TimescaleDB with Compose.
2. **Telemetry pipeline:** Implement sensor/edge simulation, MQTT publishing/subscribing, FastAPI ingestion, persistence, and a basic live-data view. Verify valid, invalid, duplicate, and disconnected-message behavior.
3. **Health analytics:** Add configured TCF/NPF/salt-passage calculations and the EKF. Test steady-state gating, units, missing optional sensors, and deterministic degradation.
4. **Cloud predictions:** Add synthetic dataset generation, fault classification, source-change detection, and particle-filter forecasts. Test each against known simulator ground truth, reporting demo-only results.
5. **Application/workflows:** Build backend-driven device, health, analytics, alerts, and simulation-control views; then add replacement, inventory, serviceability, and dispatch transitions.
6. **End-to-end rehearsal:** Run the named scenario from reset through delivery, test safety/fallback behavior, document startup/reset steps, and then record the video.

The first acceptance milestone should be **synthetic readings → edge processing → real MQTT broker → FastAPI subscriber → database persistence → dashboard display**. Advanced prediction and dispatch should follow that verified pipeline.

## Implementation status — local software demo

The repository now contains a runnable first software slice under `software/`. Start it from the repository root with:

```powershell
uv run --directory software --project . uvicorn aquatwin.api:app --host 127.0.0.1 --port 8000
```

The operational console is at `/console`; the product walkthrough remains at `/`. The local app starts an AMQTT broker, edge/device simulator, and backend MQTT subscriber in the application lifecycle. The publishers and subscriber communicate over MQTT/TCP. An optional separate Mosquitto container configuration is in `software/compose.mosquitto.yaml`.

Implemented in this first slice:

- Deterministic, configurable synthetic municipal/tanker/borewell profiles and fault injection.
- Edge validation, steady-state gating, TCF, fill-time-derived flow, configured NPF, salt passage, simplified three-state EKF, and counter-fallback metadata.
- Versioned MQTT telemetry, command and acknowledgement topics; subscriber validation and sequence deduplication.
- SQLite persistence for devices, telemetry, analysis snapshots, stage health, predictions, alerts, source-change events, inventory, and replacement workflow.
- Synthetic 500-particle remaining-life forecast, explainable rule-based demo cause scoring, and repeated-observation source-profile inference.
- Browser dashboard consuming API data, plus simulation and service-workflow controls.
- Automated unit and local-MQTT integration tests under `software/tests`.

Not represented as complete or validated: a trained gradient-boosting model, a mathematically full Bayesian change-point implementation, physical calibration, field accuracy, TimescaleDB, production authentication/security, and physical ESP32 firmware. SQLite and embedded AMQTT are local demo defaults; the optional Compose profile uses a separate Mosquitto broker. Configuration values that stand in for missing physical parameters remain explicitly synthetic.
