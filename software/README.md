# AquaTwin Local Software Demo

This is the first runnable software slice of AquaTwin: a synthetic device publishes processed telemetry over a real MQTT TCP connection; the backend subscribes, validates it, stores it in SQLite, runs demo analytics, and exposes results to an operational dashboard.

```text
Synthetic plant → Edge validation + indicators + EKF
                → MQTT broker (AMQTT, TCP)
                → Backend MQTT subscriber → SQLite history
                → Analytics → FastAPI → live dashboard
```

The existing root-level presentation remains available as a product walkthrough. This software demo is a separate working pipeline, not a backend-dependent redesign of that walkthrough.

## Run locally

From the repository root:

```powershell
uv run --directory software --project . uvicorn aquatwin.api:app --host 127.0.0.1 --port 8000
```

On Windows, run `software\run-demo.cmd`.

Open:

- `http://127.0.0.1:8000/console` — operational live demo dashboard
- `http://127.0.0.1:8000/docs` — interactive API documentation
- `http://127.0.0.1:8000/` — HTML product walkthrough
- `http://127.0.0.1:8000/api/health` — service, broker, simulator, and database status

`uv` creates and manages the project's virtual environment and resolves the dependencies in `pyproject.toml`. The local developer profile starts an AMQTT broker inside the app lifecycle, so Docker/Mosquitto is not required for the demo. MQTT still traverses a real local TCP broker and is not replaced by a function call or in-memory-only event bus.

Optional Mosquitto-backed container mode:

```powershell
docker compose -f software/compose.mosquitto.yaml up --build
```

This starts Mosquitto as a separate local broker and configures the application to use it instead of the embedded development broker.

To stop the demo, press **Ctrl+C** in the terminal.

## What is implemented

- Device `AQT-1001` and deterministic municipal, tanker, and borewell profiles.
- Correlated simulated sensor values and selectable faults.
- Edge range/steady-state checks and sensor-quality handling.
- TCF, tank-fill-derived permeate flow, normalized flow when configured inputs exist, and salt passage.
- A simplified, configurable three-state EKF for normalized fouling resistance, its growth rate, and TDS offset.
- Versioned MQTT telemetry and command/ack topics.
- MQTT subscriber validation, deduplication by device/sequence, and SQLite persistence.
- Synthetic remaining-life particle forecast, transparent demo fault scoring, and possible source-profile shift detection.
- Filter-health records, alerts, automatic replacement recommendations, inventory and serviceability checks, and simulated dispatch tracking.
- REST endpoints and a browser dashboard that refreshes from backend data.
- Resettable scenario controls, source changes, fault injection, accelerated simulation time, and workflow progression.
- One-click reproducible `hyderabad_tanker_fouling` run: municipal baseline → tanker-like feed shift → gradual RO fouling → forecast/recommendation. The primary run auto-pauses when a replacement recommendation is created so the presenter can demonstrate approval and dispatch.

## Technical boundaries

- The values, source distributions, degradation rates, EKF covariance, EOL boundary, safety threshold, and inventory/service records come from `config/demo.json`. They are explicitly synthetic demo settings, not physical calibration or field-validated results.
- The fault cause estimator is an explainable synthetic **rule-based scorer**, not a trained gradient-boosting model. The remaining-life simulation is a particle forecast for demonstration and is not a validated RUL claim.
- The source detector infers a possible profile change from configured feed-TDS/temperature distributions. It does not prove the physical water source.
- NPF depends on the configured demo NDP and tank-volume/reference-flow assumptions. Replace these with calibrated purifier data before interpreting them physically.
- The safety interlock simulator is separate from advisory analytics. Predictive recommendations cannot clear or override an interlock.
- SQLite is used for portable local persistence. A TimescaleDB migration and Mosquitto deployment are future production-shaped tasks.
- The local AMQTT broker runs in-process for convenience; MQTT publishers/subscribers still use TCP. `compose.mosquitto.yaml` is included for a later separate Mosquitto deployment.

## Main API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Runtime health/status |
| GET | `/api/dashboard` | Latest device state, filter health, prediction, alerts, and service counts |
| GET | `/api/telemetry?limit=100` | Persisted telemetry history |
| GET | `/api/predictions` | Prediction history |
| GET | `/api/alerts` | Alert history |
| GET | `/api/service/requests` | Replacement/service workflow |
| POST | `/api/simulation/start` | Start the accelerated demo clock |
| POST | `/api/simulation/pause` | Pause the clock |
| POST | `/api/simulation/reset` | Reset simulator and create a clean run |
| POST | `/api/simulation/source` | Set `municipal`, `tanker`, or `borewell` |
| POST | `/api/simulation/fault` | Set one supported fault or `healthy` |
| POST | `/api/simulation/advance` | Advance simulated days explicitly |
| POST | `/api/simulation/scenario` | Start the deterministic primary municipal → tanker → RO-fouling scenario |
| GET | `/api/commands/{command_id}` | Check the device MQTT command acknowledgement |
| POST | `/api/service/requests/{id}/approve` | Approve and reserve a cartridge |
| POST | `/api/service/requests/{id}/dispatch` | Check pincode serviceability and create dispatch |
| POST | `/api/service/requests/{id}/deliver` | Mark the synthetic dispatch delivered |

See `/docs` for request payloads and response schemas.

## Checks

From the repository root, run:

```powershell
uv run --directory software --project . python -m unittest discover -s tests -v
```

On Windows, run `software\run-tests.cmd`.

The integration test starts an actual local MQTT broker, publishes simulator telemetry, verifies the backend subscriber and SQLite insert, then exercises demo analytics. Tests do not claim model or physical-system validation.
