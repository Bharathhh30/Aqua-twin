from __future__ import annotations

import json
import math
import random
import threading
import time
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import paho.mqtt.client as mqtt

from .config import DEVICE_ID, MQTT_HOST, MQTT_PORT, SIM
from .edge import EdgeProcessor
from .mqtt_topics import ACK_TOPIC, COMMAND_TOPIC, STATUS_TOPIC, TELEMETRY_TOPIC


class DeviceSimulator:
    """Synthetic purifier plant + simulated device firmware/edge process."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.edge = EdgeProcessor()
        self.rng = random.Random(int(SIM["random_seed"]))
        self.source = "municipal"
        self.fault = "healthy"
        self.fault_started_day = 0.0
        self.scenario_id: str | None = None
        self.scenario_source_changed = False
        self.scenario_fault_started = False
        self.simulation_day = 0.0
        self.tick_count = 0
        self.sequence = 0
        self.processed_volume_l = 0.0
        self.uv_burn_hours = 0.0
        self.running = True
        self.connected = False
        self.connected_event = threading.Event()
        self.run_id = str(uuid4())
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.seen_commands: set[str] = set()
        self.seen_order: list[str] = []
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"aquatwin-edge-{uuid4().hex[:8]}",
            protocol=mqtt.MQTTv311,
        )
        self.client.reconnect_delay_set(min_delay=1, max_delay=8)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message

    def start(self) -> None:
        self.client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
        self.client.loop_start()
        if not self.connected_event.wait(timeout=5):
            self.client.loop_stop()
            raise RuntimeError(f"Edge simulator could not connect to MQTT at {MQTT_HOST}:{MQTT_PORT}")
        self.thread = threading.Thread(target=self._loop, name="aquatwin-device-simulator", daemon=True)
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=3)
        try:
            self.client.disconnect()
        finally:
            self.client.loop_stop()

    def _on_connect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any) -> None:
        if reason_code.is_failure:
            self.connected = False
            return
        self.connected = True
        self.connected_event.set()
        client.subscribe(COMMAND_TOPIC, qos=1)
        self.publish_status()

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, disconnect_flags: Any, reason_code: Any, properties: Any) -> None:
        self.connected = False
        self.connected_event.clear()

    def _publish_json(self, topic: str, payload: dict[str, Any], *, retain: bool = False) -> None:
        if not self.connected:
            return
        self.client.publish(topic, json.dumps(payload, separators=(",", ":")), qos=1, retain=retain)

    def publish_status(self) -> None:
        with self.lock:
            status = {
                "schema_version": "device-status.v1",
                "device_id": DEVICE_ID,
                "simulation_run_id": self.run_id,
                "source_profile_selected": self.source,
                "fault_injection": self.fault,
                "scenario_id": self.scenario_id,
                "simulation_day": round(self.simulation_day, 2),
                "tick_count": self.tick_count,
                "simulator_running": self.running,
                "mqtt_connected": self.connected,
                "demo_data": True,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
        self._publish_json(STATUS_TOPIC, status, retain=True)

    def _ack(self, command: dict[str, Any], success: bool, message: str) -> None:
        self._publish_json(
            ACK_TOPIC,
            {
                "schema_version": "command-ack.v1",
                "command_id": command.get("command_id"),
                "device_id": DEVICE_ID,
                "success": success,
                "message": message,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )

    def _on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            command = json.loads(message.payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        command_id = str(command.get("command_id", ""))
        if not command_id or command_id in self.seen_commands:
            return
        self.seen_commands.add(command_id)
        self.seen_order.append(command_id)
        if len(self.seen_order) > 1000:
            self.seen_commands.discard(self.seen_order.pop(0))
        action = command.get("action")
        parameters = command.get("parameters") or {}
        success, message_text = True, "accepted"
        with self.lock:
            if action == "start":
                self.running = True
                message_text = "simulation started"
            elif action == "pause":
                self.running = False
                message_text = "simulation paused"
            elif action == "set_source":
                source = parameters.get("source")
                if source not in SIM["source_profiles"]:
                    success, message_text = False, "unknown water-source profile"
                else:
                    self.scenario_id = None
                    self.source = source
                    message_text = f"water-source profile set to {source}"
            elif action == "set_fault":
                fault = parameters.get("fault")
                valid_faults = {
                    "healthy", "sediment_clog", "ro_fouling", "ro_bypass", "pump_wear",
                    "uv_ageing", "carbon_exhaustion", "sensor_malfunction",
                }
                if fault not in valid_faults:
                    success, message_text = False, "unknown fault scenario"
                else:
                    self.scenario_id = None
                    self.fault = fault
                    self.simulation_day = 0.0
                    self.fault_started_day = 0.0
                    self.edge.reset()
                    message_text = f"fault scenario set to {fault}"
            elif action == "advance":
                days = float(parameters.get("days", 1))
                self.simulation_day += days
                self.tick_count += 1
                self.processed_volume_l += 32.0 * days
                self.uv_burn_hours += 0.6 * days
                message_text = f"advanced simulation by {days:g} day(s)"
            elif action == "reset":
                self.source = "municipal"
                self.fault = "healthy"
                self.simulation_day = 0.0
                self.fault_started_day = 0.0
                self.tick_count = 0
                self.processed_volume_l = 0.0
                self.uv_burn_hours = 0.0
                self.running = True
                self.run_id = str(uuid4())
                self.scenario_id = None
                self.scenario_source_changed = False
                self.scenario_fault_started = False
                self.edge.reset()
                self.rng = random.Random(int(SIM["random_seed"]))
                message_text = "new clean demo run started"
            elif action == "run_scenario":
                scenario = parameters.get("scenario")
                if scenario != "hyderabad_tanker_fouling":
                    success, message_text = False, "unknown deterministic demo scenario"
                else:
                    self.source = "municipal"
                    self.fault = "healthy"
                    self.fault_started_day = 0.0
                    self.simulation_day = 0.0
                    self.tick_count = 0
                    self.processed_volume_l = 0.0
                    self.uv_burn_hours = 0.0
                    self.running = True
                    self.run_id = str(uuid4())
                    self.scenario_id = scenario
                    self.scenario_source_changed = False
                    self.scenario_fault_started = False
                    self.edge.reset()
                    self.rng = random.Random(int(SIM["random_seed"]))
                    message_text = "deterministic municipal → tanker → RO-fouling scenario started"
            else:
                success, message_text = False, f"unknown command: {action}"
        self._ack(command, success, message_text)
        if success:
            self.publish_status()
            if action in ("set_fault", "set_source", "advance", "reset"):
                self.publish_telemetry(force_steady=True)

    def _plant_sample(self, force_steady: bool = False) -> dict[str, Any]:
        with self.lock:
            source_id = self.source
            fault = self.fault
            day = self.simulation_day
            fault_started_day = self.fault_started_day
            tick = self.tick_count
            run_id = self.run_id
            volume = self.processed_volume_l
            uv_hours = self.uv_burn_hours

        profile = SIM["source_profiles"][source_id]
        optional_kit = bool(SIM["optional_sensor_kit_enabled"])
        temperature = self.rng.gauss(profile["temperature_c"], profile["temperature_std_c"])
        tcf = math.exp(2640.0 * (1.0 / 298.0 - 1.0 / (273.0 + temperature)))
        input_tds = max(1.0, self.rng.gauss(profile["feed_tds_mean_ppm"], profile["feed_tds_std_ppm"]))
        salt_passage = 35.0 / 650.0
        inlet_pressure = 0.18 + self.rng.gauss(0, 0.002)
        current_ma = 520.0 + self.rng.gauss(0, 9)
        uv_current = 310.0 + self.rng.gauss(0, 4)
        flow_factor = 1.0

        fault_cfg = SIM["faults"]
        if fault == "sediment_clog":
            severity = min(0.85, 0.18 + max(0.0, day) * 0.035)
            inlet_pressure -= fault_cfg["sediment_clog"]["max_pressure_drop_mpa"] * severity
            flow_factor *= 1.0 - 0.43 * severity
        elif fault == "ro_fouling":
            severity = min(
                fault_cfg["ro_fouling"]["max_normalized_resistance"],
                max(0.0, day - fault_started_day) * fault_cfg["ro_fouling"]["growth_per_simulated_day"],
            )
            flow_factor *= 1.0 - fault_cfg["ro_fouling"]["max_flow_loss_fraction"] * severity
            salt_passage += fault_cfg["ro_fouling"]["max_salt_passage_increase"] * severity
        elif fault == "ro_bypass":
            salt_passage += fault_cfg["ro_bypass"]["salt_passage_increase"]
        elif fault == "pump_wear":
            wear = min(1.0, 0.55 + max(0.0, day) * 0.01)
            current_ma += fault_cfg["pump_wear"]["current_increase_ma"] * wear
        elif fault == "uv_ageing":
            age = min(1.0, 0.60 + max(0.0, day) * 0.01)
            uv_current *= 1.0 - fault_cfg["uv_ageing"]["current_loss_fraction"] * age
        elif fault == "carbon_exhaustion":
            volume = max(volume, fault_cfg["carbon_exhaustion"]["volume_proxy_l"] + 20.0)
        elif fault == "sensor_malfunction":
            input_tds = 9999.0

        reference_flow = SIM["reference_flow_lpm"]
        ndp_ratio = SIM["reference_ndp_mpa"] / SIM["demo_ndp_mpa"]
        permeate_flow = reference_flow * tcf * ndp_ratio * flow_factor
        fill_time = SIM["tank_usable_volume_l"] / max(0.02, permeate_flow)
        input_tds = round(input_tds, 1)
        output_tds = round(input_tds * salt_passage, 1) if fault != "sensor_malfunction" else 41.2

        stable = force_steady or tick % 17 not in (1, 2)
        runtime = 180.0 if stable else 24.0
        self.sequence += 1
        return {
            "simulation_run_id": run_id,
            "sequence": self.sequence,
            "simulation_day": day,
            "input_tds_ppm": input_tds,
            "output_tds_ppm": output_tds,
            "water_temp_c": round(temperature, 2),
            "pump_runtime_s": runtime,
            "valve_state": "purifying",
            "pump_on": True,
            "flow_stable": stable,
            "tank_float_state": "filling",
            "tank_fill_time_min": round(fill_time * (1.55 if fault == "sediment_clog" else 1.0), 2),
            "tank_usable_volume_l": SIM["tank_usable_volume_l"],
            "inlet_pressure_mpa": round(inlet_pressure, 4) if optional_kit else None,
            "ro_pressure_mpa": round(SIM["demo_ndp_mpa"], 4) if optional_kit else None,
            "reject_flow_lpm": round(permeate_flow * 1.25, 4) if optional_kit else None,
            "pump_current_ma": round(current_ma, 1) if optional_kit else None,
            "uv_current_ma": round(uv_current, 1) if optional_kit else None,
            "uv_burn_hours": round(uv_hours, 1),
            "processed_volume_l": round(volume, 1),
            "leak_detected": False,
            "dry_run_detected": False,
            "uv_fault": fault == "uv_ageing" and uv_hours >= SIM["safety"]["uv_lamp_hard_limit_hours"],
            "demo_ndp_mpa": SIM["demo_ndp_mpa"],
            "reference_ndp_mpa": SIM["reference_ndp_mpa"],
            "reference_flow_lpm": SIM["reference_flow_lpm"],
        }

    def publish_telemetry(self, force_steady: bool = False) -> None:
        raw = self._plant_sample(force_steady=force_steady)
        edge_message = self.edge.process(raw)
        if edge_message.edge_event:
            event = {
                "schema_version": "device-event.v1",
                "device_id": DEVICE_ID,
                "simulation_run_id": raw["simulation_run_id"],
                "sequence": raw["sequence"],
                "timestamp": datetime.now(timezone.utc).isoformat(),
                **edge_message.edge_event.model_dump(),
                "demo_data": True,
            }
            # The API subscribes to telemetry; edge event is carried alongside its telemetry envelope.
        payload = edge_message.model_dump(mode="json")
        self._publish_json(TELEMETRY_TOPIC, payload)

    def _loop(self) -> None:
        interval = max(0.1, float(SIM["tick_seconds"]))
        while not self.stop_event.is_set():
            started = time.monotonic()
            if self.running and self.connected:
                with self.lock:
                    if self.scenario_id == "hyderabad_tanker_fouling":
                        if self.tick_count >= 8 and not self.scenario_source_changed:
                            self.source = "tanker"
                            self.scenario_source_changed = True
                            self.publish_status()
                        if self.tick_count >= 14 and not self.scenario_fault_started:
                            self.fault = "ro_fouling"
                            self.fault_started_day = self.simulation_day
                            self.scenario_fault_started = True
                            self.publish_status()
                telemetry_every = max(1, int(SIM["telemetry_publish_every_ticks"]))
                if self.tick_count % telemetry_every == 0:
                    self.publish_telemetry()
                with self.lock:
                    self.tick_count += 1
                    self.simulation_day += float(SIM["simulated_days_per_tick"])
                    self.processed_volume_l += 32.0
                    self.uv_burn_hours += 0.6
                self.publish_status()
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.05, interval - elapsed))

