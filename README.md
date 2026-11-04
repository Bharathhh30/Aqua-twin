# AquaTwin Interactive Walkthrough

A browser-only, full-screen technical product walkthrough for the AquaTwin water-purifier predictive-maintenance concept, alongside a runnable local software demo.

## Live software pipeline

The working software slice is in [`software/`](software/README.md). It runs a synthetic purifier and edge simulator, sends versioned messages through a real local MQTT broker, stores accepted telemetry in SQLite, calculates demo analytics, and serves an operational dashboard.

```powershell
uv run --directory software --project . uvicorn aquatwin.api:app --host 127.0.0.1 --port 8000
```

Windows shortcut: `software\run-demo.cmd`.

- `http://127.0.0.1:8000/console` — live software dashboard
- `http://127.0.0.1:8000/docs` — API explorer
- `http://127.0.0.1:8000/` — interactive product walkthrough

The local backend is a **synthetic demo**, not field validation. See the software README for controls, endpoints, architecture boundaries, and tests.

This is intentionally **not a conventional slide deck**. It follows one continuous story:

```text
household water → purifier stages → sensor readings → edge processing
→ MQTT summary → cloud analytics → customer explanation → service workflow
```

The recurring purifier schematic, moving water/data indicators, source selector, fault scenarios, customer-app mockup, and service dashboard all use one shared deterministic simulation state. The presenter can move linearly, jump to any chapter, inspect components, change the water source, inject faults, and replay the end-to-end walkthrough.

## Run locally

No build step, package installation, backend, or internet connection is required.

1. Open `index.html` in a modern browser, or serve the folder locally:

   ```powershell
   python -m http.server 8000
   ```

2. Open `http://localhost:8000`.
3. Use the fullscreen control or press **F**.

Scene and deterministic scenario deep links are supported:

```text
http://localhost:8000/#scene-06
http://localhost:8000/?source=tanker&fault=ro-fouling&day=0#scene-09
```

## Browser smoke test

With the local server running, open `http://localhost:8000/tests/smoke.html`. The small browser test walks all 14 scenes and checks the shared source/fault state, example calculations, configurable NPF, sensor-quality fallback, safety message, and simulated delivery workflow.

## Presenter controls

| Control | Action |
|---|---|
| Left / Right arrows | Previous / next chapter |
| Space | Next chapter |
| Chapter rail or progress segments | Jump to a chapter |
| Top water-source selector | Switch municipal, tanker, or borewell demo profile |
| **N** | Open presenter notes and development-blueprint notes |
| **P** | Pause / resume ambient motion |
| **R** | Replay current scene transition |
| **F** | Toggle browser fullscreen |
| Scenario Lab | Inject a fault; run or pause accelerated demo time; select simulation speed |
| Final scene | Play the guided end-to-end sequence |

The final replay walks through the healthy baseline, tanker-source shift, membrane-fouling warning, household explanation, simulated service/delivery steps, and a separate bypass alert. It can be stopped by navigating manually or resetting the journey.

## Scenes

1. Problem — calendar estimates vs. changing purifier conditions
2. Physical water path — the reusable purifier schematic
3. Component explorer — stage-specific roles and evidence
4. Measurement layer — clickable sensor markers
5. Edge device — simulated ESP32-S3 responsibilities
6. Edge processing — TCF, salt passage, configurable NPF, and EKF states
7. MQTT — versioned summary transport
8. Cloud architecture — ingestion, history, analytics, and application boundaries
9. Predictive analytics — EKF, particle filter, fault classifier, and change point
10. Filter health — stage state, forecast range, and independent safety lane
11. Customer app — interactive concept mockup
12. Service operations — proposed inventory and dispatch workflow
13. Scenario Lab — source and fault injection
14. End-to-end journey — replay and project targets

## Technical integrity

- Synthetic source readings, fault behavior, app records, inventory, and forecast states are for demonstration only; they are not physical calibration data or field-validated predictions.
- The input TDS, output TDS, and temperature example is available via **Load brief example · 650 / 35 / 28°C** in the formula scene. It switches the shared demo source to the synthetic tanker profile.
- Salt passage is calculated as `TDSout / TDSin`.
- TCF follows the project formula. NPF remains uncomputed until the presenter supplies `Qp`, `NDPref`, and `NDP`; no missing physical calibration value is silently invented.
- Sensor malfunction suppresses health confidence and illustrates the counter-based fallback rather than being classified as a filter failure.
- UF is shown in the water path, but the UI explicitly avoids claiming a dedicated UF prognostics model from the available signals. Pump is a component, not a filter. TDS probes are measurement points, not filtration stages.
- The interface distinguishes pincode-based model priors from dispatch serviceability. The service workflow is a proposed software extension.
- Project performance figures are shown as **targets to validate**, not achieved results.
- Predictive output is advisory. Existing output-TDS, UV, leak, and dry-run interlocks remain independent.

## Development-blueprint structure

Each scene has structured content in `SCENES` inside `app.js`:

- `kicker`, `title`, `lead`, and `foot` — presenter-facing narrative
- `visual` and `zone` — visualization and architecture location
- `notes` — technical talk track and guardrails
- `blueprint` — future interface, data-contract, calibration, or validation work

The Notes drawer exposes both the story and its corresponding engineering breadcrumb. This makes the walkthrough useful as a prototype today and an implementation-planning artifact later. `AQUATWIN_ARCHITECTURE_HANDOFF.md` contains the broader proposed repository structure, contracts, analytics boundaries, and incremental implementation plan.

## Files

- `index.html` — presentation shell and controls
- `styles.css` — visual system, responsive layout, diagrams, and transitions
- `app.js` — shared demo state, synthetic profiles, scene visuals, formulas, and interactions
- `favicon.svg` — small AquaTwin water-mark icon
- `tests/smoke.html` — in-browser walkthrough and interaction smoke test
- `AQUATWIN_ARCHITECTURE_HANDOFF.md` — broader technical handoff
- `project.pdf` — original AquaTwin abstract
