from __future__ import annotations

import math
import random
import statistics
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import DEVICE, SIM

FAULT_NAMES = {
    "sediment_clog": "Sediment clog",
    "ro_fouling": "RO scaling / fouling",
    "ro_bypass": "RO bypass / O-ring leak",
    "pump_wear": "Pump wear",
    "uv_ageing": "UV lamp ageing",
    "carbon_exhaustion": "Carbon exhaustion estimate",
    "sensor_malfunction": "Sensor malfunction",
}


def _clamp(value: float, low: float = 0.0, high: float = 100.0) -> float:
    return min(high, max(low, value))


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    position = (len(values) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return values[lower]
    fraction = position - lower
    return values[lower] * (1 - fraction) + values[upper] * fraction


class SourceProfileDetector:
    """Gaussian demo profile inference from feed TDS and temperature observations."""

    def __init__(self) -> None:
        self.current_profile: str | None = None
        self.candidate_profile: str | None = None
        self.candidate_streak = 0

    def update(self, tds: float, temperature: float | None) -> tuple[dict[str, Any] | None, dict[str, float]]:
        profiles = SIM["source_profiles"]
        log_scores: dict[str, float] = {}
        for name, profile in profiles.items():
            tds_sd = max(1.0, float(profile["feed_tds_std_ppm"]))
            tds_log_likelihood = -0.5 * ((tds - profile["feed_tds_mean_ppm"]) / tds_sd) ** 2 - math.log(tds_sd)
            temperature_log_likelihood = 0.0
            if temperature is not None:
                temp_sd = max(0.1, float(profile["temperature_std_c"]))
                temperature_log_likelihood = (
                    -0.5 * ((temperature - profile["temperature_c"]) / temp_sd) ** 2 - math.log(temp_sd)
                )
            # Equal priors are a demo assumption; they are not geographical ground truth.
            log_scores[name] = tds_log_likelihood + temperature_log_likelihood
        peak = max(log_scores.values())
        weights = {key: math.exp(value - peak) for key, value in log_scores.items()}
        total = sum(weights.values()) or 1.0
        posterior = {key: value / total for key, value in weights.items()}
        candidate = max(posterior, key=posterior.get)
        confidence = posterior[candidate]

        if self.current_profile is None:
            self.candidate_profile = candidate
            self.candidate_streak += 1
            if self.candidate_streak >= 3:
                self.current_profile = candidate
            return None, posterior
        if candidate == self.current_profile or confidence < 0.70:
            self.candidate_profile = None
            self.candidate_streak = 0
            return None, posterior
        if self.candidate_profile == candidate:
            self.candidate_streak += 1
        else:
            self.candidate_profile = candidate
            self.candidate_streak = 1
        if self.candidate_streak < 3:
            return None, posterior

        previous = self.current_profile
        self.current_profile = candidate
        self.candidate_profile = None
        self.candidate_streak = 0
        return {
            "previous_profile": previous,
            "inferred_profile": candidate,
            "confidence": round(confidence, 4),
            "observed_input_tds_ppm": tds,
            "observed_temp_c": temperature,
        }, posterior


class AnalyticsEngine:
    """Deterministic, explicitly synthetic demo analytics."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.run_id: str | None = None
        self.source_detector = SourceProfileDetector()
        self.posterior: dict[str, float] = {}
        self.rng_seed = int(SIM["random_seed"])

    def reset_run(self, run_id: str) -> None:
        with self.lock:
            if run_id != self.run_id:
                self.run_id = run_id
                self.source_detector = SourceProfileDetector()
                self.posterior = {}
                self.rng_seed = int(SIM["random_seed"])

    def _classify(
        self,
        telemetry: dict[str, Any],
        history: list[dict[str, Any]],
        source_posterior: dict[str, float],
    ) -> dict[str, Any]:
        quality = telemetry["quality"]
        m = telemetry["measurements"]
        indicators = telemetry["indicators"]
        previous = history[-2] if len(history) > 1 else None
        previous_salt = previous["indicators"].get("salt_passage") if previous else None
        salt = indicators.get("salt_passage")
        npf = indicators.get("normalized_permeate_flow")

        if not quality["readings_valid"]:
            return {
                "fault_id": "sensor_malfunction",
                "fault": FAULT_NAMES["sensor_malfunction"],
                "probability": 0.99,
                "supporting_indicators": quality.get("sensor_faults", []),
                "model": "demo-quality-gate-v1",
            }

        scores = {key: 0.02 for key in FAULT_NAMES if key != "sensor_malfunction"}
        evidence: dict[str, list[str]] = {key: [] for key in scores}
        if salt is not None and (
            salt >= 0.16
            or (previous_salt is not None and salt - previous_salt >= SIM["edge"]["salt_passage_sudden_jump"])
        ):
            scores["ro_bypass"] += 0.94
            if previous_salt is not None:
                evidence["ro_bypass"].append(f"salt passage jumped by {salt - previous_salt:.3f} in one accepted observation")
            else:
                evidence["ro_bypass"].append(f"salt passage is acutely elevated at {salt:.3f}")
        elif salt is not None and salt > (35 / 650) + 0.014:
            scores["ro_fouling"] += min(0.80, (salt - 35 / 650) * 7.0)
            evidence["ro_fouling"].append("salt passage is elevated versus the configured demo baseline")

        if len(history) >= 3:
            first, last = history[-min(8, len(history))], history[-1]
            first_npf = first["indicators"].get("normalized_permeate_flow")
            last_npf = last["indicators"].get("normalized_permeate_flow")
            if first_npf is not None and last_npf is not None:
                npf_drop = first_npf - last_npf
                if npf_drop > 0.035:
                    scores["ro_fouling"] += min(0.75, npf_drop * 4.0)
                    evidence["ro_fouling"].append(f"normalized permeate flow fell by {npf_drop:.3f} in the evidence window")
        if npf is not None and npf < 0.84 and (salt or 0) > 0.065:
            scores["ro_fouling"] += 0.22
            evidence["ro_fouling"].append("flow and salt-passage indicators changed together")

        if m.get("inlet_pressure_mpa") is not None and m.get("inlet_pressure_mpa") < 0.145:
            scores["sediment_clog"] += 0.75
            evidence["sediment_clog"].append("optional inlet pressure is below the demo baseline")
        if m.get("tank_fill_time_min") is not None and m["tank_fill_time_min"] > 43:
            scores["sediment_clog"] += 0.32
            evidence["sediment_clog"].append("tank filling is slower than the configured demo baseline")
        if salt is not None and salt <= 0.075 and scores["sediment_clog"] > 0.25:
            evidence["sediment_clog"].append("salt passage did not show a matching RO-quality rise")

        if m.get("pump_current_ma") is not None and m["pump_current_ma"] > 700:
            scores["pump_wear"] += min(0.85, (m["pump_current_ma"] - 700) / 500)
            evidence["pump_wear"].append("optional pump current is elevated for the demo load")
        if (
            (m.get("uv_current_ma") is not None and m["uv_current_ma"] < 235)
            or m.get("uv_burn_hours", 0) >= SIM["safety"]["uv_lamp_hard_limit_hours"]
        ):
            scores["uv_ageing"] += 0.82
            evidence["uv_ageing"].append("UV current or burn-hour estimate is beyond the configured demo band")
        if m.get("processed_volume_l", 0) >= SIM["faults"]["carbon_exhaustion"]["volume_proxy_l"]:
            scores["carbon_exhaustion"] += 0.76
            evidence["carbon_exhaustion"].append("simulated treated volume reached the carbon estimate threshold")

        # Normalize transparent scenario scores. These are not calibrated probabilities.
        total = sum(max(0.001, value) for value in scores.values())
        probabilities = {key: max(0.001, value) / total for key, value in scores.items()}
        top = max(probabilities, key=probabilities.get)
        if probabilities[top] < 0.36:
            return {
                "fault_id": None,
                "fault": "No fault pattern stands out",
                "probability": round(probabilities[top], 4),
                "supporting_indicators": ["No configured synthetic fault pattern crossed the demo review threshold."],
                "probabilities": probabilities,
                "model": "demo-rule-scorer-v1",
            }
        return {
            "fault_id": top,
            "fault": FAULT_NAMES[top],
            "probability": round(probabilities[top], 4),
            "supporting_indicators": evidence.get(top, []),
            "probabilities": probabilities,
            "model": "demo-rule-scorer-v1",
        }

    def _forecast(
        self,
        telemetry: dict[str, Any],
        history: list[dict[str, Any]],
        profile: str | None,
        classification: dict[str, Any],
    ) -> dict[str, Any] | None:
        if not telemetry["quality"]["readings_valid"]:
            return None
        npf = telemetry["indicators"].get("normalized_permeate_flow")
        if npf is None:
            return None
        if classification.get("fault_id") == "ro_bypass":
            return None

        npf_series = [
            item["indicators"].get("normalized_permeate_flow")
            for item in history[-15:]
            if item["quality"]["readings_valid"] and item["indicators"].get("normalized_permeate_flow") is not None
        ]
        slopes: list[float] = []
        accepted_history = [
            item for item in history[-15:]
            if item["quality"]["readings_valid"] and item["indicators"].get("normalized_permeate_flow") is not None
        ]
        for left, right in zip(accepted_history, accepted_history[1:]):
            left_npf = left["indicators"].get("normalized_permeate_flow")
            right_npf = right["indicators"].get("normalized_permeate_flow")
            day_diff = right["simulation_day"] - left["simulation_day"]
            if left_npf is not None and right_npf is not None and day_diff > 0:
                decrease = (left_npf - right_npf) / day_diff
                if decrease > 0:
                    slopes.append(decrease)

        source_prior = {"municipal": 0.0032, "tanker": 0.0047, "borewell": 0.0062}
        inferred_growth = statistics.median(slopes) if slopes else source_prior.get(profile or "municipal", 0.004)
        if classification.get("fault_id") == "ro_fouling":
            inferred_growth = max(inferred_growth, 0.0042)
        growth_sigma = max(0.00055, inferred_growth * 0.20)
        particle_count = int(SIM["analytics"]["particle_count"])
        horizon = min(
            float(SIM["analytics"]["forecast_horizon_days"]),
            float(SIM["manufacturer_max_life_days"]["ro_membrane"]),
        )
        eol_npf = float(SIM["analytics"]["forecast_eol_npf"])
        source_seed = sum(ord(char) for char in (profile or "municipal"))
        seed = self.rng_seed + int(round(float(telemetry["simulation_day"]) * 1000)) + source_seed
        rng = random.Random(seed)
        remaining: list[float] = []
        for _ in range(particle_count):
            growth = max(0.0002, rng.gauss(inferred_growth, growth_sigma))
            eol = (npf - eol_npf) / growth
            remaining.append(_clamp(eol, 0.0, horizon))
        p10, p50, p90 = (_percentile(remaining, value) for value in (0.10, 0.50, 0.90))
        now = datetime.now(timezone.utc)
        return {
            "stage_id": "ro_membrane",
            "p10_days": round(p10, 1),
            "p50_days": round(p50, 1),
            "p90_days": round(p90, 1),
            "failure_window_start": (now + timedelta(days=p10)).date().isoformat(),
            "failure_window_end": (now + timedelta(days=p90)).date().isoformat(),
            "probable_cause": classification.get("fault"),
            "confidence": round(min(0.92, 0.35 + len(npf_series) * 0.025), 3),
            "model_version": "synthetic-particle-forecast-v1",
            "evidence": [
                f"{particle_count} deterministic demo particles",
                f"recent accepted observations: {len(npf_series)}",
                f"inferred normalized-flow decline: {inferred_growth:.5f} per simulated day",
                f"configured demo end-of-life NPF: {eol_npf:.2f}",
                "uncertainty is illustrative and not field calibrated",
            ],
        }

    def analyze(self, telemetry: dict[str, Any], history: list[dict[str, Any]]) -> dict[str, Any]:
        with self.lock:
            run_id = telemetry["simulation_run_id"]
            self.reset_run(run_id)
            source_event = None
            source_posterior: dict[str, float] = self.posterior
            if telemetry["quality"]["readings_valid"] and telemetry["quality"]["operating_state"] == "steady":
                measurements = telemetry["measurements"]
                source_event, source_posterior = self.source_detector.update(
                    measurements["input_tds_ppm"], measurements["water_temp_c"]
                )
                self.posterior = source_posterior

            inferred_profile = max(source_posterior, key=source_posterior.get) if source_posterior else None
            classification = self._classify(telemetry, history, source_posterior)
            prediction = self._forecast(telemetry, history, inferred_profile, classification)

            measurements = telemetry["measurements"]
            indicators = telemetry["indicators"]
            valid = telemetry["quality"]["readings_valid"]
            npf = indicators.get("normalized_permeate_flow")
            salt = indicators.get("salt_passage")
            fill_time = measurements.get("tank_fill_time_min")
            inlet_pressure = measurements.get("inlet_pressure_mpa")
            health: list[dict[str, Any]] = []

            sediment_score = 96.0
            if fill_time is not None:
                sediment_score -= max(0.0, fill_time - 38.0) * 4.8
            if inlet_pressure is not None:
                sediment_score -= max(0.0, 0.18 - inlet_pressure) * 360.0
            health.append(
                self._stage_health(
                    "sediment",
                    sediment_score if valid else None,
                    "degrading" if sediment_score < 78 else "healthy",
                    None,
                    evidence=["tank-fill trend", "optional inlet-pressure trend"],
                )
            )

            carbon_volume = measurements.get("processed_volume_l", 0.0)
            carbon_max = float(SIM["faults"]["carbon_exhaustion"]["volume_proxy_l"])
            carbon_score = _clamp(100.0 * (1.0 - carbon_volume / max(1.0, carbon_max)))
            health.append(
                self._stage_health(
                    "carbon",
                    carbon_score if valid else None,
                    "estimated" if carbon_score < 75 else "healthy_estimate",
                    None,
                    evidence=["processed-volume proxy only; no chlorine sensor"],
                )
            )

            ro_score: float | None = None
            if valid and npf is not None and salt is not None:
                flow_penalty = max(0.0, 1.0 - npf) * 95.0
                salt_penalty = max(0.0, salt - (35 / 650)) * 350.0
                ro_score = _clamp(100.0 - max(flow_penalty, salt_penalty))
            ro_status = "healthy"
            cause_id = classification.get("fault_id")
            if cause_id in ("ro_fouling", "ro_bypass") or (ro_score is not None and ro_score < 72):
                ro_status = "degrading" if cause_id == "ro_fouling" else "inspect"
            health.append(
                self._stage_health(
                    "ro_membrane",
                    ro_score,
                    ro_status if valid else "sensor_confidence_low",
                    prediction,
                    classification.get("fault") if cause_id in ("ro_fouling", "ro_bypass") else None,
                    evidence=[
                        "temperature-corrected normalized permeate flow",
                        "salt-passage trend",
                        "three-state edge EKF normalized fouling estimate",
                    ],
                )
            )

            # UF is represented as installed but has no dedicated forecast from these signals.
            health.append(
                self._stage_health(
                    "uf",
                    None,
                    "not_individually_modelled",
                    None,
                    evidence=["no dedicated UF-health sensor or calibrated model in the base signal set"],
                )
            )

            uv_current = measurements.get("uv_current_ma")
            if uv_current is not None:
                uv_score = _clamp(100.0 * uv_current / 310.0)
            else:
                uv_score = _clamp(100.0 * (1.0 - measurements.get("uv_burn_hours", 0) / SIM["safety"]["uv_lamp_hard_limit_hours"]))
            if not valid:
                uv_score = None
            health.append(
                self._stage_health(
                    "uv",
                    uv_score,
                    "estimated" if uv_score is not None and uv_score < 72 else "healthy_estimate",
                    None,
                    "UV lamp ageing estimate" if cause_id == "uv_ageing" else None,
                    evidence=["optional lamp-current reading or burn-hour estimate; configured demo relationship"],
                )
            )

            alerts: list[dict[str, Any]] = []
            if source_event:
                alerts.append(
                    {
                        "stage_id": None,
                        "alert_type": "possible_water_profile_change",
                        "severity": "low",
                        "description": f"Feed measurements are more consistent with a {source_event['inferred_profile']}-like demo profile.",
                        "evidence": [
                            "TDS level / variation and temperature profile comparison",
                            "source identity is inferred and not proven by TDS",
                        ],
                    }
                )
            if not valid:
                alerts.append(
                    {
                        "stage_id": None,
                        "alert_type": "sensor_quality_fault",
                        "severity": "medium",
                        "description": "Sensor quality is invalid or out of range. Health analytics are gated; use the configured counter fallback.",
                        "evidence": telemetry["quality"]["sensor_faults"],
                    }
                )
            if cause_id:
                severity = "high" if cause_id in ("ro_bypass", "sensor_malfunction") else "medium"
                stage_for_fault = {
                    "ro_fouling": "ro_membrane",
                    "ro_bypass": "ro_membrane",
                    "sediment_clog": "sediment",
                    "pump_wear": "pump",
                    "uv_ageing": "uv",
                    "carbon_exhaustion": "carbon",
                }
                alerts.append(
                    {
                        "stage_id": stage_for_fault.get(cause_id),
                        "alert_type": cause_id,
                        "severity": severity,
                        "description": f"Demo analytics identified a possible {classification['fault'].lower()} pattern.",
                        "evidence": classification["supporting_indicators"],
                    }
                )
            for lockout, active in telemetry["safety"].items():
                if lockout.endswith("_active") and active:
                    alerts.append(
                        {
                            "stage_id": None,
                            "alert_type": f"safety_{lockout}",
                            "severity": "critical",
                            "description": "Existing purifier safety interlock is active. Predictive advice cannot override it.",
                            "evidence": [lockout],
                        }
                    )

            recommendation = None
            if valid and cause_id in ("ro_fouling", "sediment_clog", "carbon_exhaustion", "uv_ageing"):
                stage_for_cause = {
                    "ro_fouling": ("ro_membrane", SIM["service"]["ro_sku"]),
                    "sediment_clog": ("sediment", SIM["service"]["sediment_sku"]),
                    "carbon_exhaustion": ("carbon", SIM["service"]["carbon_sku"]),
                    "uv_ageing": ("uv", SIM["service"]["uv_sku"]),
                }
                stage_id, sku = stage_for_cause[cause_id]
                below_warning = prediction and prediction["p50_days"] <= SIM["replacement_warning_days"]
                if below_warning or cause_id in ("sediment_clog", "carbon_exhaustion", "uv_ageing"):
                    recommendation = {
                        "stage_id": stage_id,
                        "sku": sku,
                        "pincode": DEVICE["pincode"],
                        "reason": classification["fault"],
                    }

            return {
                "device_id": telemetry["device_id"],
                "simulation_run_id": run_id,
                "sequence": telemetry["sequence"],
                "source_profile": {
                    "inferred": inferred_profile,
                    "confidence": round(source_posterior.get(inferred_profile, 0.0), 4) if inferred_profile else 0.0,
                    "posterior": {key: round(value, 4) for key, value in source_posterior.items()},
                },
                "source_event": source_event,
                "classification": classification,
                "prediction": prediction,
                "filter_health": health,
                "alerts": alerts,
                "replacement_recommendation": recommendation,
                "model_notice": "Synthetic demo model outputs; not field validated.",
            }

    @staticmethod
    def _stage_health(
        stage_id: str,
        score: float | None,
        status: str,
        prediction: dict[str, Any] | None,
        cause: str | None = None,
        evidence: list[str] | None = None,
    ) -> dict[str, Any]:
        usable = score is not None
        return {
            "stage_id": stage_id,
            "status": status,
            "health_score": round(_clamp(score), 1) if usable else None,
            "rul_p10_days": prediction.get("p10_days") if prediction and stage_id == "ro_membrane" else None,
            "rul_p50_days": prediction.get("p50_days") if prediction and stage_id == "ro_membrane" else None,
            "rul_p90_days": prediction.get("p90_days") if prediction and stage_id == "ro_membrane" else None,
            "probable_cause": cause,
            "confidence": prediction.get("confidence", 0.0) if prediction and stage_id == "ro_membrane" else (0.0 if not usable else 0.35),
            "evidence": evidence or [],
        }

