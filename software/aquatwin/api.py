from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from .config import DEVICE, DEVICE_ID, PROJECT_DIR, SIM, SOFTWARE_DIR
from .contracts import AdvanceCommand, ApprovalBody, FaultCommand, ScenarioCommand, SourceCommand
from .database import Database
from .runtime import LocalMqttBroker, MqttRuntime, async_start_runtime

logging.basicConfig(
    level=os.environ.get("AQUATWIN_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("aquatwin.api")
DB = Database()


@asynccontextmanager
async def lifespan(app: FastAPI):
    DB.initialize()
    embedded_broker = LocalMqttBroker() if os.environ.get("AQUATWIN_EMBEDDED_BROKER", "1") != "0" else None
    if embedded_broker:
        await embedded_broker.start()
    runtime: MqttRuntime | None = None
    try:
        runtime = await asyncio.to_thread(async_start_runtime, DB)
        app.state.runtime = runtime
        app.state.broker = embedded_broker
        logger.info("AquaTwin demo runtime ready for %s", DEVICE_ID)
        yield
    finally:
        if runtime:
            await asyncio.to_thread(runtime.stop)
        if embedded_broker:
            await embedded_broker.stop()
        logger.info("AquaTwin demo runtime stopped")


app = FastAPI(
    title="AquaTwin Demo API",
    version="0.1.0",
    description=(
        "Local synthetic-device demo. MQTT telemetry, edge indicators, demo analytics, SQLite history, "
        "and proposed service workflow. Outputs are not field validated."
    ),
    lifespan=lifespan,
)


class AcknowledgeBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    acknowledged_by: str = Field(default="demo-operator", min_length=1, max_length=80)


def runtime_or_503() -> MqttRuntime:
    runtime = getattr(app.state, "runtime", None)
    if not runtime:
        raise HTTPException(status_code=503, detail="Demo runtime is starting")
    return runtime


def publish_command(action: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
    runtime = runtime_or_503()
    try:
        return runtime.send_command(action, parameters)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, Any]:
    runtime = runtime_or_503()
    broker = getattr(app.state, "broker", None)
    broker_running = broker.running if broker else runtime.connected.is_set()
    return runtime.health(broker_running)


@app.get("/api/config")
def demo_config() -> dict[str, Any]:
    return {
        "demo_data": True,
        "device": DEVICE,
        "water_sources": {
            name: {
                "profile_label": value["profile_label"],
                "feed_tds_mean_ppm": value["feed_tds_mean_ppm"],
                "feed_tds_std_ppm": value["feed_tds_std_ppm"],
                "temperature_c": value["temperature_c"],
            }
            for name, value in SIM["source_profiles"].items()
        },
        "simulation": {
            "tick_seconds": SIM["tick_seconds"],
            "simulated_days_per_tick": SIM["simulated_days_per_tick"],
            "particle_count": SIM["analytics"]["particle_count"],
            "configured_demo_eol_npf": SIM["analytics"]["forecast_eol_npf"],
            "output_tds_cutoff_ppm": SIM["output_tds_cutoff_ppm"],
            "optional_sensor_kit_enabled": SIM["optional_sensor_kit_enabled"],
        },
        "notice": "Configuration contains synthetic demo assumptions, not physical calibration.",
    }


@app.get("/api/dashboard")
def dashboard() -> dict[str, Any]:
    data = DB.dashboard()
    data["runtime"] = health()
    data["counts"] = DB.counts()
    return data


@app.get("/api/telemetry")
def telemetry(limit: int = Query(default=100, ge=1, le=1000)) -> dict[str, Any]:
    return {"device_id": DEVICE_ID, "items": DB.telemetry(limit), "demo_data": True}


@app.get("/api/predictions")
def predictions(limit: int = Query(default=50, ge=1, le=250)) -> dict[str, Any]:
    return {"items": DB.prediction_history(limit), "demo_data": True}


@app.get("/api/alerts")
def alerts(limit: int = Query(default=100, ge=1, le=250)) -> dict[str, Any]:
    return {"items": DB.alerts(limit), "demo_data": True}


@app.post("/api/alerts/{alert_id}/acknowledge")
def acknowledge_alert(alert_id: int, body: AcknowledgeBody) -> dict[str, Any]:
    result = DB.acknowledge_alert(alert_id)
    if not result:
        raise HTTPException(status_code=404, detail="Alert not found")
    return {"alert": result, "acknowledged_by": body.acknowledged_by}


@app.get("/api/source-changes")
def source_changes(limit: int = Query(default=50, ge=1, le=100)) -> dict[str, Any]:
    return {"items": DB.source_events(limit), "demo_data": True}


@app.get("/api/inventory")
def inventory() -> dict[str, Any]:
    return {"items": DB.inventory(), "demo_data": True}


@app.get("/api/service/requests")
def service_requests() -> dict[str, Any]:
    return {"items": DB.service_requests(), "demo_data": True}


@app.post("/api/simulation/start")
def start_simulation() -> dict[str, Any]:
    return publish_command("start")


@app.post("/api/simulation/pause")
def pause_simulation() -> dict[str, Any]:
    return publish_command("pause")


@app.post("/api/simulation/reset")
def reset_simulation() -> dict[str, Any]:
    DB.reset_inventory()
    return publish_command("reset")


@app.post("/api/simulation/source")
def set_source(body: SourceCommand) -> dict[str, Any]:
    return publish_command("set_source", {"source": body.source})


@app.post("/api/simulation/fault")
def set_fault(body: FaultCommand) -> dict[str, Any]:
    return publish_command("set_fault", {"fault": body.fault})


@app.post("/api/simulation/advance")
def advance_simulation(body: AdvanceCommand) -> dict[str, Any]:
    return publish_command("advance", {"days": body.days})


@app.post("/api/simulation/scenario")
def run_scenario(body: ScenarioCommand) -> dict[str, Any]:
    DB.reset_inventory()
    return publish_command("run_scenario", {"scenario": body.scenario})


@app.get("/api/commands/{command_id}")
def command_status(command_id: str) -> dict[str, Any]:
    return runtime_or_503().command_status(command_id)


@app.post("/api/service/requests/{request_id}/approve")
def approve_service_request(request_id: str, body: ApprovalBody) -> dict[str, Any]:
    try:
        result = DB.approve_request(request_id, body.approved_by)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail="Replacement request not found")
    return {"request": result}


@app.post("/api/service/requests/{request_id}/dispatch")
def dispatch_service_request(request_id: str) -> dict[str, Any]:
    result, error = DB.dispatch_request(request_id)
    if error:
        code = 404 if error == "request_not_found" else 409
        raise HTTPException(status_code=code, detail=error)
    return {"request": result}


@app.post("/api/service/requests/{request_id}/deliver")
def deliver_service_request(request_id: str) -> dict[str, Any]:
    try:
        result = DB.deliver_request(request_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not result:
        raise HTTPException(status_code=404, detail="Replacement request not found")
    return {"request": result}


@app.post("/api/service/requests/{request_id}/complete")
def complete_replacement(request_id: str) -> dict[str, Any]:
    result = DB.complete_replacement(request_id)
    if not result:
        raise HTTPException(status_code=404, detail="Replacement request not found")
    if result["status"] != "replaced":
        raise HTTPException(status_code=409, detail="Delivery must be marked delivered before replacement completion")
    return {"request": result}


@app.get("/console", include_in_schema=False)
def console() -> FileResponse:
    return FileResponse(SOFTWARE_DIR / "web" / "index.html")


@app.get("/console.css", include_in_schema=False)
def console_css() -> FileResponse:
    return FileResponse(SOFTWARE_DIR / "web" / "console.css", media_type="text/css")


@app.get("/console.js", include_in_schema=False)
def console_js() -> FileResponse:
    return FileResponse(SOFTWARE_DIR / "web" / "console.js", media_type="text/javascript")


@app.get("/", include_in_schema=False)
def pitch_walkthrough() -> FileResponse:
    return FileResponse(PROJECT_DIR / "index.html")


@app.get("/styles.css", include_in_schema=False)
def pitch_styles() -> FileResponse:
    return FileResponse(PROJECT_DIR / "styles.css", media_type="text/css")


@app.get("/app.js", include_in_schema=False)
def pitch_script() -> FileResponse:
    return FileResponse(PROJECT_DIR / "app.js", media_type="text/javascript")


@app.get("/favicon.svg", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(PROJECT_DIR / "favicon.svg", media_type="image/svg+xml")
