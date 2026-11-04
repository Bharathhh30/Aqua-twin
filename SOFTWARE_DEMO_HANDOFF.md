# AquaTwin Software Demo — Handoff Guide

This document explains what is implemented, how to run it, and how to demonstrate it. It is intended as a handoff for teammates, evaluators, or anyone setting up the project on another machine.

## What this project contains

AquaTwin currently has two complementary demos:

1. **Interactive product walkthrough** — a 14-scene, browser-based explanation of the product concept and its architecture.
2. **Live software demo** — a working synthetic device pipeline that sends telemetry over MQTT, stores it, runs demo analytics, and presents the results in an operational dashboard.

The walkthrough explains the product. The live console demonstrates the software pipeline. They are linked, but they are not the same application: the walkthrough has browser-local illustrative visuals, while the console reads live state from the running backend.

## Quick start on Windows

### Prerequisites

- Windows 10 or 11.
- Internet access on the first run so `uv` can download the Python environment and dependencies.
- [`uv`](https://docs.astral.sh/uv/) installed and available on `PATH`.
- A modern browser.

Docker is **not required** for the default local demo. The app starts a local MQTT broker as part of its run lifecycle. Docker is only needed if you choose the optional separate Mosquitto setup below.

### Start the demo

From the project root, double-click `software\run-demo.cmd`, or run:

```cmd
software\run-demo.cmd
```

Alternatively, use PowerShell or a terminal:

```powershell
cd software
uv run --project . uvicorn aquatwin.api:app --host 127.0.0.1 --port 8000
```

The first start may take longer while dependencies are installed. Wait until the terminal reports that the application has started. Keep that terminal open while using the demo.

By default, the server binds to `127.0.0.1` and is available only on the computer where it is running. To hand the project to someone else, share the project folder and this guide; they can run the same start command on their machine. This default is intentional—the local demo is not configured as a network-hosted or production service.

### Open the applications

- **Live software dashboard:** http://127.0.0.1:8000/console
- **Interactive product walkthrough:** http://127.0.0.1:8000/
- **FastAPI endpoint explorer:** http://127.0.0.1:8000/docs
- **Runtime health:** http://127.0.0.1:8000/api/health

Press **Ctrl+C** in the server terminal to stop the demo.

## How to play with the live demo

The live console at `/console` polls the backend and displays the current device state. The dashboard is driven by telemetry and API responses; its controls send commands to the simulator.

### Recommended end-to-end demonstration

1. Open `/console` and confirm the **API** and **MQTT** indicators show online.
2. Start from a clean state by selecting **Reset run** if needed. Reset creates a new simulation run and restores the synthetic inventory. Previous telemetry remains in the local database but is scoped to the previous run.
3. Select **Primary journey**.
4. Watch the simulation progress through:
   - Municipal-like baseline readings.
   - A switch to a tanker-like feed profile.
   - A possible source-profile change inferred from repeated feed measurements.
   - Gradual simulated RO fouling.
   - An RO remaining-life range, alert, and replacement recommendation.
5. The primary scenario automatically pauses when a replacement recommendation is created. This gives you time to explain the result.
6. In **Replacement workflow**, move the request through:
   - **Approve**
   - **Check + dispatch** — checks the demo inventory and serviceable-pincode list.
   - **Mark delivered**
   - **Complete replacement**
7. Use the linked product walkthrough if you want to explain the product journey and architecture alongside the live pipeline.

The scenario is deterministic in its configuration and repeatable after reset. Synthetic readings include controlled measurement variation, so individual readings may differ slightly while the same stages and events recur.

### Try individual sources and faults

Use **Water source** and **Fault injection** in the dashboard control panel. Supported profiles and faults include:

- Municipal-like, tanker-like, and borewell-like feed profiles.
- Healthy baseline.
- Sediment clog.
- RO scaling/fouling.
- RO bypass/O-ring leak.
- Pump wear.
- UV lamp ageing.
- Carbon exhaustion estimate.
- Sensor malfunction.

The selected source and fault change the simulator output. The effect can be followed through latest measurements, charts, edge quality, analytics, alerts, and service recommendations.

Other controls:

- **Start / Pause** — control the accelerated device clock.
- **+10 demo days** — advance simulated time explicitly.
- **Reset run** — start a clean scenario context and restore demo inventory.
- **Acknowledge** — acknowledge an alert without deleting its history.

The source selector is a configurable synthetic profile, not a claim about the actual quality of a neighborhood or water supplier.

## Architecture and how it works

```text
Synthetic purifier plant
  → Edge simulator
  → MQTT telemetry topic over TCP
  → FastAPI MQTT subscriber
  → SQLite telemetry and event history
  → Analytics
  → REST API
  → Live operations dashboard

Dashboard controls
  → FastAPI command endpoint
  → MQTT command topic
  → Simulator command handler
  → MQTT command acknowledgement
```

### Synthetic plant and device simulator

The simulator models device `AQT-1001`. It generates correlated sensor and purifier signals based on the configured source profile, operating state, simulated time, and selected fault. It also accepts MQTT commands to start, pause, reset, change source, inject faults, advance time, or run the named primary scenario.

### Edge processing

The edge simulator validates readings and gates health calculations to valid steady-state observations. It calculates:

- **TCF** using the formula in the project brief.
- Permeate flow from configured usable tank volume and fill time.
- **Salt passage** from output TDS divided by input TDS.
- **NPF** using configured reference flow and NDP parameters.
- A simplified, configurable three-state EKF estimate for fouling resistance, fouling growth rate, and TDS offset.

When readings are invalid, health analytics are gated and fallback-counter state is reported. Safety indicators are separate from predictive recommendations.

### MQTT messaging

The publisher and subscriber use a real MQTT client/broker path over TCP. Example topic families include:

```text
aquatwin/v1/devices/AQT-1001/telemetry
aquatwin/v1/devices/AQT-1001/status
aquatwin/v1/devices/AQT-1001/commands
aquatwin/v1/devices/AQT-1001/command-acks
```

The broker distributes messages; it does not run AquaTwin analytics. The subscriber validates telemetry and ignores duplicate device/sequence messages.

### Backend and database

FastAPI exposes the dashboard and workflow API. SQLite provides portable local persistence for device, telemetry, analytics snapshot, filter health, prediction, alert, source-change, inventory, and replacement-request records.

The default local setup uses an embedded AMQTT broker to avoid a separate Docker requirement. This is a development convenience: MQTT messages still travel through a broker over TCP. The app can also be configured to use a separate Mosquitto broker.

### Analytics

The live demo currently provides:

- Filter-specific health estimates for supported stages.
- A synthetic 500-particle remaining-life forecast with P10/P50/P90 bounds.
- An explainable **rule-based demo fault scorer** with supporting indicators.
- A possible source-profile change inferred from repeated TDS and temperature observations.
- Alerts and replacement recommendations.

It does **not** currently contain a trained Gradient Boosting model or a full Bayesian change-point implementation. The analytics are intentionally modest and transparent rather than presented as validated models.

### Service workflow

A recommendation can create a simulated replacement request with a stage and cartridge SKU. Service operations then handle approval, inventory reservation, pincode serviceability, dispatch, delivery, and replacement completion.

Pincode-based model priors and pincode-based dispatch serviceability are separate concepts and workflows.

## API overview

Open `/docs` while the demo is running for interactive schemas and request forms. Main endpoints include:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Broker, subscriber, simulator, and telemetry-ingestion status |
| `GET` | `/api/config` | Device and synthetic configuration summary |
| `GET` | `/api/dashboard` | Current dashboard state |
| `GET` | `/api/telemetry` | Persisted telemetry for the current run |
| `GET` | `/api/predictions` | Prediction history for the current run |
| `GET` | `/api/alerts` | Alert history for the current run |
| `GET` | `/api/source-changes` | Inferred source-profile change events |
| `GET` | `/api/inventory` | Demo inventory |
| `GET` | `/api/service/requests` | Replacement and dispatch requests |
| `POST` | `/api/simulation/start` | Start the simulator clock |
| `POST` | `/api/simulation/pause` | Pause the simulator clock |
| `POST` | `/api/simulation/reset` | Start a clean simulation run |
| `POST` | `/api/simulation/source` | Change the water-source profile |
| `POST` | `/api/simulation/fault` | Inject a fault or restore the healthy baseline |
| `POST` | `/api/simulation/advance` | Advance simulated time |
| `POST` | `/api/simulation/scenario` | Run `hyderabad_tanker_fouling` |
| `GET` | `/api/commands/{command_id}` | Check MQTT command acknowledgement |
| `POST` | `/api/service/requests/{id}/approve` | Approve a replacement request |
| `POST` | `/api/service/requests/{id}/dispatch` | Check stock/serviceability and dispatch |
| `POST` | `/api/service/requests/{id}/deliver` | Mark demo delivery complete |
| `POST` | `/api/service/requests/{id}/complete` | Complete the replacement workflow |

## Run tests

From the repository root:

```cmd
software\run-tests.cmd
```

Or run directly:

```powershell
cd software
uv run --project . python -m unittest discover -s tests -v
```

Tests exercise formulas, steady-state and sensor-fault gating, synthetic cause scenarios, source inference, output-TDS safety behavior, SQLite deduplication, replacement lifecycle transitions, and end-to-end MQTT telemetry/commands.

## Optional: separate Mosquitto broker with Docker

The default run does not require Docker. To run the containerized app with a separate Eclipse Mosquitto broker, from the repository root:

```powershell
docker compose -f software/compose.mosquitto.yaml up --build
```

Then use the same dashboard and API URLs on port `8000`. Stop the Compose services with:

```powershell
docker compose -f software/compose.mosquitto.yaml down
```

The Compose file uses an anonymous local broker profile intended for a controlled demo only, not internet-facing or production deployment.

## Project files

```text
/
├─ index.html, styles.css, app.js       Interactive 14-scene product walkthrough
├─ AQUATWIN_ARCHITECTURE_HANDOFF.md     Architecture and implementation handoff
├─ project.pdf                          Original project abstract
└─ software/
   ├─ README.md                         Software-demo-specific notes
   ├─ run-demo.cmd                      Windows start shortcut
   ├─ run-tests.cmd                     Windows test shortcut
   ├─ config/demo.json                  Synthetic profiles and demo parameters
   ├─ aquatwin/
   │  ├─ simulator.py                   Synthetic purifier and device command handler
   │  ├─ edge.py                        Validation, indicators, EKF, safety state
   │  ├─ runtime.py                     MQTT broker/subscriber lifecycle
   │  ├─ analytics.py                   Synthetic forecasts, cause scorer, source inference
   │  ├─ database.py                    SQLite persistence and service workflow
   │  └─ api.py                         FastAPI endpoints and local web routes
   ├─ web/                              Live operations dashboard
   ├─ tests/                            Unit and local-MQTT integration tests
   └─ compose.mosquitto.yaml            Optional separate Mosquitto deployment
```

## Important limitations and interpretation

- **All purifier readings and source profiles are synthetic.** They are useful for repeatable software testing and demonstration, not water-quality reporting.
- **Forecasts and health scores are illustrative demo outputs.** They are not field-validated performance or remaining-life accuracy.
- The fault classifier is a **rule-based scorer**, not the proposed trained Gradient Boosting model.
- Source-profile detection is an inference from configured distributions, not proof of municipal, tanker, or borewell source.
- NPF and degradation behavior use explicit demo assumptions in `software/config/demo.json`; they require physical calibration before real-world interpretation.
- SQLite and the embedded broker are local-development choices. TimescaleDB, production Mosquitto configuration, authentication/security, and deployment hardening remain future work.
- Physical ESP32-S3 hardware, ESP-IDF firmware, sensors, purifier testing, and field validation are not part of this software-only demo.
- Predictive analytics are advisory. They do not override existing output-TDS, UV, leak, or dry-run safety interlocks.
- Project metrics in the original abstract are targets to validate, not results achieved by this software demo.
