from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("AQUATWIN_MQTT_HOST", "127.0.0.1")
os.environ.setdefault("AQUATWIN_MQTT_PORT", "18884")

from amqtt.broker import Broker

from aquatwin.analytics import AnalyticsEngine
from aquatwin.config import DEVICE_ID, SIM
from aquatwin.database import Database
from aquatwin.edge import EdgeProcessor
from aquatwin.runtime import MqttRuntime
from aquatwin.simulator import DeviceSimulator

logging.getLogger("amqtt").setLevel(logging.ERROR)
logging.getLogger("transitions").setLevel(logging.ERROR)


class EdgeAndAnalyticsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.simulator = DeviceSimulator()
        self.edge = EdgeProcessor()

    def tearDown(self) -> None:
        # Test instances never open network connections.
        self.simulator.stop_event.set()

    def test_temperature_correction_at_reference_temperature(self) -> None:
        self.assertAlmostEqual(EdgeProcessor.temperature_correction_factor(25.0), 1.0, places=10)
        self.assertAlmostEqual(EdgeProcessor.temperature_correction_factor(28.0), 1.092, delta=0.005)

    def test_valid_sample_generates_edge_indicators(self) -> None:
        raw = self.simulator._plant_sample(force_steady=True)
        message = self.edge.process(raw)
        payload = message.model_dump(mode="json")
        self.assertEqual(payload["schema_version"], "edge-telemetry.v1")
        self.assertEqual(payload["device_id"], DEVICE_ID)
        self.assertEqual(payload["quality"]["operating_state"], "steady")
        self.assertGreater(payload["indicators"]["normalized_permeate_flow"], 0.85)
        self.assertAlmostEqual(payload["indicators"]["salt_passage"], 35 / 650, delta=0.004)
        self.assertFalse(payload["safety"]["advisory_can_override"])

    def test_sensor_outlier_is_gated_and_falls_back_to_counter(self) -> None:
        raw = self.simulator._plant_sample(force_steady=True)
        raw["input_tds_ppm"] = 9999
        raw["processed_volume_l"] = 1200
        message = self.edge.process(raw).model_dump(mode="json")
        self.assertFalse(message["quality"]["readings_valid"])
        self.assertEqual(message["quality"]["operating_state"], "degraded")
        self.assertIsNone(message["indicators"]["normalized_permeate_flow"])
        self.assertTrue(message["edge_state"]["fallback_counter_active"])
        self.assertEqual(message["edge_state"]["fallback_processed_volume_l"], 1200)

    def test_existing_output_tds_interlock_is_independent_from_prediction(self) -> None:
        self.simulator.source = "borewell"
        self.simulator.fault = "ro_bypass"
        raw = self.simulator._plant_sample(force_steady=True)
        message = self.edge.process(raw).model_dump(mode="json")
        self.assertTrue(message["safety"]["output_tds_cutoff_active"])
        self.assertFalse(message["safety"]["advisory_can_override"])

    def test_healthy_synthetic_baseline_does_not_create_fault(self) -> None:
        analytics = AnalyticsEngine()
        history = []
        analysis = None
        for _ in range(8):
            raw = self.simulator._plant_sample(force_steady=True)
            payload = self.edge.process(raw).model_dump(mode="json")
            history.append(payload)
            analysis = analytics.analyze(payload, history)
        self.assertIsNotNone(analysis)
        self.assertIsNone(analysis["classification"]["fault_id"])
        self.assertEqual(analysis["classification"]["model"], "demo-rule-scorer-v1")

    def test_bypass_injection_is_detected_as_a_sudden_quality_change(self) -> None:
        analytics = AnalyticsEngine()
        history = []
        raw = self.simulator._plant_sample(force_steady=True)
        first = self.edge.process(raw).model_dump(mode="json")
        history.append(first)
        analytics.analyze(first, history)

        self.simulator.fault = "ro_bypass"
        raw = self.simulator._plant_sample(force_steady=True)
        second = self.edge.process(raw).model_dump(mode="json")
        history.append(second)
        analysis = analytics.analyze(second, history)

        self.assertEqual(analysis["classification"]["fault_id"], "ro_bypass")
        self.assertIsNotNone(second["edge_event"])
        self.assertGreater(second["indicators"]["salt_passage"], 0.15)

    def test_synthetic_faults_produce_distinct_demo_causes(self) -> None:
        fixtures = {
            "sediment_clog": "sediment_clog",
            "ro_fouling": "ro_fouling",
            "ro_bypass": "ro_bypass",
            "pump_wear": "pump_wear",
            "uv_ageing": "uv_ageing",
            "carbon_exhaustion": "carbon_exhaustion",
            "sensor_malfunction": "sensor_malfunction",
        }
        for injected_fault, expected_cause in fixtures.items():
            with self.subTest(fault=injected_fault):
                simulator = DeviceSimulator()
                edge = EdgeProcessor()
                analytics = AnalyticsEngine()
                simulator.fault = injected_fault
                if injected_fault == "carbon_exhaustion":
                    simulator.processed_volume_l = 1900
                history = []
                analysis = None
                for day in range(12):
                    simulator.simulation_day = float(day)
                    simulator.tick_count += 1
                    raw = simulator._plant_sample(force_steady=True)
                    payload = edge.process(raw).model_dump(mode="json")
                    history.append(payload)
                    analysis = analytics.analyze(payload, history)
                self.assertIsNotNone(analysis)
                self.assertEqual(analysis["classification"]["fault_id"], expected_cause)
                simulator.stop_event.set()

    def test_source_shift_requires_repeated_pattern_and_is_an_inference(self) -> None:
        simulator = DeviceSimulator()
        edge = EdgeProcessor()
        analytics = AnalyticsEngine()
        history = []
        for day in range(4):
            simulator.simulation_day = float(day)
            payload = edge.process(simulator._plant_sample(force_steady=True)).model_dump(mode="json")
            history.append(payload)
            analysis = analytics.analyze(payload, history)
        simulator.source = "tanker"
        events = []
        for day in range(4, 9):
            simulator.simulation_day = float(day)
            payload = edge.process(simulator._plant_sample(force_steady=True)).model_dump(mode="json")
            history.append(payload)
            analysis = analytics.analyze(payload, history)
            if analysis["source_event"]:
                events.append(analysis["source_event"])
        self.assertTrue(events)
        self.assertEqual(events[-1]["inferred_profile"], "tanker")
        self.assertIn("confidence", events[-1])
        simulator.stop_event.set()


class DatabaseWorkflowTests(unittest.TestCase):
    def test_telemetry_deduplication_and_service_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db = Database(Path(directory) / "demo.sqlite3")
            db.initialize()
            simulator = DeviceSimulator()
            try:
                payload = EdgeProcessor().process(simulator._plant_sample(force_steady=True)).model_dump(mode="json")
                self.assertTrue(db.insert_telemetry(payload))
                self.assertFalse(db.insert_telemetry(payload))
                run_id = payload["simulation_run_id"]
                db.set_simulation_state(
                    {
                        "device_id": DEVICE_ID,
                        "simulation_run_id": run_id,
                        "source_profile_selected": "tanker",
                        "fault_injection": "ro_fouling",
                        "simulator_running": True,
                    }
                )
                analysis = {
                    "device_id": DEVICE_ID,
                    "simulation_run_id": run_id,
                    "sequence": payload["sequence"],
                    "source_profile": {"inferred": "tanker", "confidence": 0.92, "posterior": {"tanker": 0.92}},
                    "classification": {"fault_id": "ro_fouling", "fault": "RO scaling / fouling", "probability": 0.8},
                    "prediction": {
                        "stage_id": "ro_membrane",
                        "p10_days": 25,
                        "p50_days": 34,
                        "p90_days": 48,
                        "failure_window_start": "2026-12-01",
                        "failure_window_end": "2026-12-24",
                        "probable_cause": "RO scaling / fouling",
                        "confidence": 0.7,
                        "model_version": "synthetic-particle-forecast-v1",
                        "evidence": ["synthetic fixture"],
                    },
                    "filter_health": [
                        {
                            "stage_id": "ro_membrane",
                            "status": "degrading",
                            "health_score": 72,
                            "rul_p10_days": 25,
                            "rul_p50_days": 34,
                            "rul_p90_days": 48,
                            "probable_cause": "RO scaling / fouling",
                            "confidence": 0.7,
                            "evidence": ["flow trend"],
                        }
                    ],
                    "alerts": [{"stage_id": "ro_membrane", "alert_type": "ro_fouling", "severity": "medium", "description": "Demo pattern", "evidence": []}],
                    "replacement_recommendation": {
                        "stage_id": "ro_membrane",
                        "sku": "AQT-RO-01",
                        "pincode": "500081",
                        "reason": "RO scaling / fouling",
                    },
                }
                db.save_analysis(DEVICE_ID, run_id, analysis)
                request = db.service_requests()[0]
                self.assertEqual(request["status"], "recommended")
                approved = db.approve_request(request["request_id"], "test")
                self.assertEqual(approved["status"], "approved")
                dispatched, error = db.dispatch_request(request["request_id"])
                self.assertIsNone(error)
                self.assertEqual(dispatched["status"], "dispatched")
                delivered = db.deliver_request(request["request_id"])
                self.assertEqual(delivered["status"], "delivered")
                completed = db.complete_replacement(request["request_id"])
                self.assertEqual(completed["status"], "replaced")
                self.assertEqual(db.inventory()[1]["available_quantity"], 3)
            finally:
                simulator.stop_event.set()


class MqttEndToEndTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.original_tick_seconds = SIM["tick_seconds"]
        SIM["tick_seconds"] = 0.12
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temp_dir.name) / "mqtt-demo.sqlite3")
        self.database.initialize()
        self.broker = Broker(
            {
                "listeners": {"default": {"type": "tcp", "bind": "127.0.0.1:18884", "max_connections": 10}},
                "sys_interval": 0,
                "auth": {"allow-anonymous": True},
                "topic-check": {"enabled": False},
            }
        )
        await self.broker.start()
        self.runtime = MqttRuntime(self.database)
        await asyncio.to_thread(self.runtime.start)

    async def asyncTearDown(self) -> None:
        await asyncio.to_thread(self.runtime.stop)
        await self.broker.shutdown()
        self.temp_dir.cleanup()
        SIM["tick_seconds"] = self.original_tick_seconds

    async def test_device_publishes_mqtt_and_backend_persists_then_fault_command_returns(self) -> None:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and self.runtime.accepted_messages < 2:
            await asyncio.sleep(0.1)
        self.assertGreaterEqual(self.runtime.accepted_messages, 2)
        before = self.runtime.accepted_messages

        self.runtime.send_command("set_fault", {"fault": "ro_bypass"})
        deadline = time.monotonic() + 5
        latest = None
        while time.monotonic() < deadline:
            state = self.database.get_simulation_state() or {}
            history = self.database.recent_telemetry(DEVICE_ID, state.get("simulation_run_id", ""), 10)
            if history and history[-1]["indicators"]["salt_passage"] and history[-1]["indicators"]["salt_passage"] > 0.15:
                latest = history[-1]
                break
            await asyncio.sleep(0.1)
        self.assertIsNotNone(latest)
        self.assertGreater(latest["indicators"]["salt_passage"], 0.15)
        self.assertGreater(self.runtime.accepted_messages, before)
        self.assertEqual(self.runtime.rejected_messages, 0)

    async def test_primary_scenario_changes_source_then_degrades_and_recommends(self) -> None:
        self.runtime.send_command("run_scenario", {"scenario": "hyderabad_tanker_fouling"})
        deadline = time.monotonic() + 8
        current = {}
        while time.monotonic() < deadline:
            current = self.database.get_simulation_state() or {}
            if current.get("source_profile_selected") == "tanker" and current.get("fault_injection") == "ro_fouling":
                if self.database.service_requests() and not current.get("simulator_running"):
                    break
            await asyncio.sleep(0.08)
        self.assertEqual(current.get("scenario_id"), "hyderabad_tanker_fouling")
        self.assertEqual(current.get("source_profile_selected"), "tanker")
        self.assertEqual(current.get("fault_injection"), "ro_fouling")
        self.assertFalse(current.get("simulator_running"))
        self.assertTrue(self.database.source_events(), f"source inference not persisted; latest analysis={self.database.dashboard().get('latest_analysis')}")
        self.assertTrue(self.database.service_requests(), f"service recommendation not persisted; latest analysis={self.database.dashboard().get('latest_analysis')}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
