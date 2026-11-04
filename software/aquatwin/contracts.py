from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class QualityV1(StrictModel):
    readings_valid: bool
    sensor_faults: list[str] = Field(default_factory=list)
    operating_state: Literal["steady", "transient", "idle", "degraded"]
    steady_state_duration_s: float = Field(ge=0)
    flow_stable: bool


class MeasurementsV1(StrictModel):
    input_tds_ppm: float | None = Field(default=None, ge=0, le=10000)
    output_tds_ppm: float | None = Field(default=None, ge=0, le=10000)
    water_temp_c: float | None = Field(default=None, ge=-5, le=80)
    pump_runtime_s: float = Field(ge=0)
    valve_state: str
    pump_on: bool
    tank_float_state: str
    tank_fill_time_min: float | None = Field(default=None, gt=0, le=600)
    tank_usable_volume_l: float | None = Field(default=None, gt=0)
    inlet_pressure_mpa: float | None = Field(default=None, ge=0, le=2)
    ro_pressure_mpa: float | None = Field(default=None, ge=0, le=2)
    reject_flow_lpm: float | None = Field(default=None, ge=0, le=100)
    pump_current_ma: float | None = Field(default=None, ge=0, le=10000)
    uv_current_ma: float | None = Field(default=None, ge=0, le=10000)
    uv_burn_hours: float = Field(ge=0)
    processed_volume_l: float = Field(ge=0)
    leak_detected: bool
    dry_run_detected: bool


class IndicatorsV1(StrictModel):
    tcf: float | None = Field(default=None, ge=0)
    permeate_flow_lpm: float | None = Field(default=None, ge=0)
    normalized_permeate_flow: float | None = Field(default=None, ge=0)
    salt_passage: float | None = Field(default=None, ge=0, le=2)
    membrane_flux_lpm_mpa: float | None = Field(default=None, ge=0)


class EdgeStateV1(StrictModel):
    estimated_fouling_resistance: float | None = None
    estimated_fouling_growth_rate_per_day: float | None = None
    estimated_tds_sensor_offset_ppm: float | None = None
    fallback_counter_active: bool = False
    fallback_processed_volume_l: float = Field(default=0, ge=0)
    fallback_counter_remaining_l: float | None = Field(default=None, ge=0)


class SafetyV1(StrictModel):
    output_tds_cutoff_active: bool
    uv_lockout_active: bool
    leak_lockout_active: bool
    dry_run_lockout_active: bool
    advisory_can_override: Literal[False] = False


class EdgeEventV1(StrictModel):
    type: str
    severity: Literal["info", "low", "medium", "high", "critical"]
    description: str


class EdgeTelemetryV1(StrictModel):
    schema_version: Literal["edge-telemetry.v1"]
    message_id: str = Field(min_length=1, max_length=100)
    device_id: str = Field(min_length=1, max_length=64)
    simulation_run_id: str = Field(min_length=1, max_length=64)
    sequence: int = Field(ge=0)
    timestamp: datetime
    simulation_day: float = Field(ge=0)
    quality: QualityV1
    measurements: MeasurementsV1
    indicators: IndicatorsV1
    edge_state: EdgeStateV1
    safety: SafetyV1
    edge_event: EdgeEventV1 | None = None
    demo_data: Literal[True] = True


class SourceCommand(StrictModel):
    source: Literal["municipal", "tanker", "borewell"]


class FaultCommand(StrictModel):
    fault: Literal[
        "healthy",
        "sediment_clog",
        "ro_fouling",
        "ro_bypass",
        "pump_wear",
        "uv_ageing",
        "carbon_exhaustion",
        "sensor_malfunction",
    ]


class AdvanceCommand(StrictModel):
    days: float = Field(default=1, ge=0.1, le=365)


class ScenarioCommand(StrictModel):
    scenario: Literal["hyderabad_tanker_fouling"]


class ApprovalBody(StrictModel):
    approved_by: str = Field(default="demo-operator", min_length=1, max_length=80)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)
