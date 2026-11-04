from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import numpy as np

from .config import DEVICE_ID, SIM
from .contracts import EdgeTelemetryV1


class ThreeStateEKF:
    """Small demo EKF over normalized (not physical-unit) membrane state."""

    def __init__(self) -> None:
        self.x = np.asarray(SIM["analytics"]["ekf_initial_state"], dtype=float)
        self.p = np.diag([0.08, 0.01, 25.0])
        self.q = np.diag(SIM["analytics"]["ekf_process_noise"])
        self.r = np.diag(SIM["analytics"]["ekf_measurement_noise"])
        self.ready = False

    def reset(self) -> None:
        self.__init__()

    def update(self, npf: float, salt_passage: float, elapsed_days: float) -> tuple[float, float, float]:
        dt = max(0.05, min(elapsed_days, 30.0))
        f = np.asarray([[1.0, dt, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]])
        x_pred = f @ self.x
        x_pred[0] = max(0.0, x_pred[0])
        p_pred = f @ self.p @ f.T + self.q * dt

        rf = max(0.0, float(x_pred[0]))
        offset = float(x_pred[2])
        h = np.asarray(
            [
                [1.0 / ((1.0 + rf) ** 2) * -1.0, 0.0, 0.0],
                [0.10 / ((1.0 + rf) ** 2), 0.0, 1.0 / 10000.0],
            ]
        )
        prediction = np.asarray(
            [
                1.0 / (1.0 + rf),
                0.0538 + 0.10 * (rf / (1.0 + rf)) + offset / 10000.0,
            ]
        )
        observation = np.asarray([max(0.0, npf), max(0.0, salt_passage)])
        innovation = observation - prediction
        s = h @ p_pred @ h.T + self.r
        try:
            gain = p_pred @ h.T @ np.linalg.inv(s)
        except np.linalg.LinAlgError:
            self.x, self.p = x_pred, p_pred
            return tuple(float(value) for value in self.x)
        self.x = x_pred + gain @ innovation
        self.x[0] = max(0.0, self.x[0])
        self.x[1] = max(0.0, self.x[1])
        identity = np.eye(3)
        # Joseph form preserves a positive-semidefinite covariance more reliably.
        self.p = (identity - gain @ h) @ p_pred @ (identity - gain @ h).T + gain @ self.r @ gain.T
        self.p = (self.p + self.p.T) / 2.0
        self.ready = True
        return tuple(float(value) for value in self.x)


class EdgeProcessor:
    def __init__(self) -> None:
        self.ekf = ThreeStateEKF()
        self.last_simulation_day: float | None = None
        self.last_valid_salt_passage: float | None = None

    def reset(self) -> None:
        self.ekf.reset()
        self.last_simulation_day = None
        self.last_valid_salt_passage = None

    @staticmethod
    def temperature_correction_factor(temperature_c: float) -> float:
        return math.exp(2640.0 * (1.0 / 298.0 - 1.0 / (273.0 + temperature_c)))

    def process(self, raw: dict[str, Any]) -> EdgeTelemetryV1:
        sensor_faults: list[str] = []
        limits = SIM["edge"]
        tds_in = raw.get("input_tds_ppm")
        tds_out = raw.get("output_tds_ppm")
        temperature = raw.get("water_temp_c")

        for name, value in (("input_tds", tds_in), ("output_tds", tds_out)):
            if value is None or not limits["valid_tds_min_ppm"] <= value <= limits["valid_tds_max_ppm"]:
                sensor_faults.append(f"{name}_invalid_or_out_of_range")
        if temperature is None or not -5 <= temperature <= 80:
            sensor_faults.append("temperature_invalid_or_out_of_range")

        flow_stable = bool(raw.get("flow_stable", False))
        runtime_s = float(raw.get("pump_runtime_s", 0))
        pump_on = bool(raw.get("pump_on", False))
        valid = not sensor_faults
        steady = (
            valid
            and pump_on
            and runtime_s > limits["steady_state_runtime_s"]
            and flow_stable
            and raw.get("valve_state") == "purifying"
        )
        operating_state = "degraded" if not valid else "steady" if steady else "transient" if pump_on else "idle"

        tcf = self.temperature_correction_factor(float(temperature)) if temperature is not None and -5 <= temperature <= 80 else None
        fill_time = raw.get("tank_fill_time_min")
        tank_volume = raw.get("tank_usable_volume_l")
        permeate_flow = float(tank_volume) / float(fill_time) if fill_time and tank_volume else None
        ndp = raw.get("demo_ndp_mpa")
        ndp_ref = raw.get("reference_ndp_mpa")
        reference_flow = raw.get("reference_flow_lpm")
        npf = None
        if steady and permeate_flow is not None and tcf is not None and ndp and ndp_ref and reference_flow:
            npf = (permeate_flow / float(reference_flow)) * (float(ndp_ref) / float(ndp)) / tcf

        salt_passage = None
        if steady and tds_in and tds_out is not None and float(tds_in) > 0:
            salt_passage = float(tds_out) / float(tds_in)

        edge_event: dict[str, Any] | None = None
        if steady and salt_passage is not None and self.last_valid_salt_passage is not None:
            if salt_passage - self.last_valid_salt_passage >= limits["salt_passage_sudden_jump"]:
                edge_event = {
                    "type": "sudden_salt_passage_increase",
                    "severity": "high",
                    "description": "A sudden salt-passage increase may indicate RO bypass or an O-ring leak. Verify the purifier and existing safety system.",
                }
        if steady and salt_passage is not None:
            self.last_valid_salt_passage = salt_passage

        estimate: tuple[float, float, float] | None = None
        sim_day = float(raw.get("simulation_day", 0))
        if steady and npf is not None and salt_passage is not None:
            previous = self.last_simulation_day
            elapsed = max(0.1, sim_day - previous) if previous is not None else 1.0
            estimate = self.ekf.update(npf, salt_passage, elapsed)
            self.last_simulation_day = sim_day

        tds_cutoff = bool(tds_out is not None and tds_out >= SIM["output_tds_cutoff_ppm"])
        uv_lockout = bool(raw.get("uv_fault", False))
        leak_lockout = bool(raw.get("leak_detected", False))
        dry_run_lockout = bool(raw.get("dry_run_detected", False))
        payload = {
            "schema_version": "edge-telemetry.v1",
            "message_id": str(uuid4()),
            "device_id": DEVICE_ID,
            "simulation_run_id": str(raw.get("simulation_run_id", "run-default")),
            "sequence": int(raw["sequence"]),
            "timestamp": datetime.now(timezone.utc),
            "simulation_day": sim_day,
            "quality": {
                "readings_valid": valid,
                "sensor_faults": sensor_faults,
                "operating_state": operating_state,
                "steady_state_duration_s": runtime_s if steady else 0.0,
                "flow_stable": flow_stable,
            },
            "measurements": {
                "input_tds_ppm": tds_in if valid else None,
                "output_tds_ppm": tds_out if valid else None,
                "water_temp_c": temperature if temperature is not None and -5 <= temperature <= 80 else None,
                "pump_runtime_s": runtime_s,
                "valve_state": raw.get("valve_state", "unknown"),
                "pump_on": pump_on,
                "tank_float_state": raw.get("tank_float_state", "unknown"),
                "tank_fill_time_min": fill_time,
                "tank_usable_volume_l": tank_volume,
                "inlet_pressure_mpa": raw.get("inlet_pressure_mpa"),
                "ro_pressure_mpa": raw.get("ro_pressure_mpa"),
                "reject_flow_lpm": raw.get("reject_flow_lpm"),
                "pump_current_ma": raw.get("pump_current_ma"),
                "uv_current_ma": raw.get("uv_current_ma"),
                "uv_burn_hours": float(raw.get("uv_burn_hours", 0)),
                "processed_volume_l": float(raw.get("processed_volume_l", 0)),
                "leak_detected": leak_lockout,
                "dry_run_detected": dry_run_lockout,
            },
            "indicators": {
                "tcf": tcf,
                "permeate_flow_lpm": permeate_flow,
                "normalized_permeate_flow": npf,
                "salt_passage": salt_passage,
                "membrane_flux_lpm_mpa": None,
            },
            "edge_state": {
                "estimated_fouling_resistance": estimate[0] if estimate else (float(self.ekf.x[0]) if self.ekf.ready else None),
                "estimated_fouling_growth_rate_per_day": estimate[1] if estimate else (float(self.ekf.x[1]) if self.ekf.ready else None),
                "estimated_tds_sensor_offset_ppm": estimate[2] if estimate else (float(self.ekf.x[2]) if self.ekf.ready else None),
                "fallback_counter_active": not valid,
                "fallback_processed_volume_l": float(raw.get("processed_volume_l", 0)),
                "fallback_counter_remaining_l": max(
                    0.0,
                    float(SIM["fallback_counter_capacity_l"]) - float(raw.get("processed_volume_l", 0)),
                ),
            },
            "safety": {
                "output_tds_cutoff_active": tds_cutoff,
                "uv_lockout_active": uv_lockout,
                "leak_lockout_active": leak_lockout,
                "dry_run_lockout_active": dry_run_lockout,
                "advisory_can_override": False,
            },
            "edge_event": edge_event,
            "demo_data": True,
        }
        return EdgeTelemetryV1.model_validate(payload)

