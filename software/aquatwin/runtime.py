from __future__ import annotations

import asyncio
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import paho.mqtt.client as mqtt
from amqtt.broker import Broker

from .analytics import AnalyticsEngine
from .config import DEVICE_ID, MQTT_HOST, MQTT_PORT, SIM
from .contracts import EdgeTelemetryV1
from .database import Database
from .mqtt_topics import ACK_TOPIC, COMMAND_TOPIC, EVENTS_TOPIC, ROOT, STATUS_TOPIC, TELEMETRY_TOPIC
from .simulator import DeviceSimulator

logger = logging.getLogger("aquatwin.runtime")


class LocalMqttBroker:
    """Embedded MQTT broker for zero-Docker local demo startup."""

    def __init__(self) -> None:
        self.broker: Broker | None = None
        self.running = False

    async def start(self) -> None:
        self.broker = Broker(
            {
                "listeners": {
                    "default": {
                        "type": "tcp",
                        "bind": f"{MQTT_HOST}:{MQTT_PORT}",
                        "max_connections": 30,
                    }
                },
                "sys_interval": 0,
                "auth": {"allow-anonymous": True},
                "topic-check": {"enabled": False},
            }
        )
        await self.broker.start()
        self.running = True
        logger.info("Local MQTT broker listening on %s:%s", MQTT_HOST, MQTT_PORT)

    async def stop(self) -> None:
        if self.broker is not None:
            await self.broker.shutdown()
        self.running = False


class MqttRuntime:
    def __init__(self, database: Database) -> None:
        self.database = database
        self.analytics = AnalyticsEngine()
        self.connected = threading.Event()
        self.simulator = DeviceSimulator()
        self.simulator_started = False
        self.accepted_messages = 0
        self.duplicate_messages = 0
        self.rejected_messages = 0
        self.status_messages = 0
        self.command_acks: dict[str, dict[str, Any]] = {}
        self.command_lock = threading.RLock()
        self.auto_paused_runs: set[str] = set()
        self.client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"aquatwin-cloud-{uuid4().hex[:8]}",
            protocol=mqtt.MQTTv311,
        )
        self.client.reconnect_delay_set(min_delay=1, max_delay=8)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message

    def start(self) -> None:
        self.client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
        self.client.loop_start()
        if not self.connected.wait(timeout=5):
            raise RuntimeError(f"Backend could not connect to MQTT at {MQTT_HOST}:{MQTT_PORT}")
        self.simulator.sequence = self.database.latest_sequence(DEVICE_ID)
        self.simulator.start()
        self.simulator_started = True

    def stop(self) -> None:
        if self.simulator_started:
            self.simulator.stop()
            self.simulator_started = False
        try:
            self.client.disconnect()
        finally:
            self.client.loop_stop()

    def _on_connect(self, client: mqtt.Client, userdata: Any, flags: Any, reason_code: Any, properties: Any) -> None:
        if reason_code.is_failure:
            logger.error("Backend MQTT connection refused: %s", reason_code)
            return
        client.subscribe(
            [
                (f"{ROOT}/{DEVICE_ID}/telemetry", 1),
                (f"{ROOT}/{DEVICE_ID}/status", 1),
                (f"{ROOT}/{DEVICE_ID}/command-acks", 1),
                (f"{ROOT}/{DEVICE_ID}/events", 1),
            ]
        )
        self.connected.set()
        logger.info("Backend MQTT subscriber connected and subscribed")

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, disconnect_flags: Any, reason_code: Any, properties: Any) -> None:
        self.connected.clear()
        if not reason_code.is_failure:
            logger.info("Backend MQTT subscriber disconnected")

    def _on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            if message.topic == TELEMETRY_TOPIC:
                self._ingest_telemetry(message.payload)
            elif message.topic == STATUS_TOPIC:
                self._ingest_status(message.payload)
            elif message.topic == ACK_TOPIC:
                self._ingest_ack(message.payload)
            elif message.topic == EVENTS_TOPIC:
                self._ingest_event(message.payload)
        except Exception:
            self.rejected_messages += 1
            logger.exception("Rejected MQTT message on %s", message.topic)

    def _ingest_telemetry(self, body: bytes) -> None:
        message = EdgeTelemetryV1.model_validate_json(body)
        payload = message.model_dump(mode="json")
        if not self.database.insert_telemetry(payload):
            self.duplicate_messages += 1
            return
        self.accepted_messages += 1
        if message.quality.operating_state == "steady" or not message.quality.readings_valid:
            history = self.database.recent_telemetry(message.device_id, message.simulation_run_id, limit=30)
            analysis = self.analytics.analyze(payload, history)
            self.database.save_analysis(
                message.device_id,
                message.simulation_run_id,
                analysis,
                source_event=analysis.get("source_event"),
                edge_event=payload.get("edge_event"),
            )
            simulation = self.database.get_simulation_state() or {}
            if (
                SIM["pause_primary_scenario_on_recommendation"]
                and analysis.get("replacement_recommendation")
                and simulation.get("scenario_id") == "hyderabad_tanker_fouling"
                and simulation.get("simulator_running")
                and self._mark_auto_pause(message.simulation_run_id)
            ):
                try:
                    self.send_command("pause")
                except RuntimeError:
                    self.auto_paused_runs.discard(message.simulation_run_id)

    def _mark_auto_pause(self, run_id: str) -> bool:
        with self.command_lock:
            if run_id in self.auto_paused_runs:
                return False
            self.auto_paused_runs.add(run_id)
            return True

    def _ingest_status(self, body: bytes) -> None:
        status = json.loads(body.decode("utf-8"))
        if status.get("device_id") != DEVICE_ID or status.get("schema_version") != "device-status.v1":
            raise ValueError("Unexpected device status contract")
        status["received_at"] = datetime.now(timezone.utc).isoformat()
        self.database.set_simulation_state(status)
        self.analytics.reset_run(status["simulation_run_id"])
        self.status_messages += 1

    def _ingest_ack(self, body: bytes) -> None:
        ack = json.loads(body.decode("utf-8"))
        command_id = ack.get("command_id")
        if command_id:
            with self.command_lock:
                self.command_acks[command_id] = ack
                if len(self.command_acks) > 500:
                    self.command_acks.pop(next(iter(self.command_acks)))

    def _ingest_event(self, body: bytes) -> None:
        # Event topic is reserved for future separately versioned device events.
        event = json.loads(body.decode("utf-8"))
        if event.get("device_id") != DEVICE_ID:
            raise ValueError("Unexpected event device")

    def send_command(self, action: str, parameters: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self.connected.is_set():
            raise RuntimeError("MQTT broker connection is not ready")
        command_id = str(uuid4())
        body = {
            "schema_version": "command.v1",
            "command_id": command_id,
            "device_id": DEVICE_ID,
            "action": action,
            "parameters": parameters or {},
            "issued_at": datetime.now(timezone.utc).isoformat(),
        }
        info = self.client.publish(COMMAND_TOPIC, json.dumps(body, separators=(",", ":")), qos=1)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise RuntimeError(f"MQTT publish failed with code {info.rc}")
        return {"command_id": command_id, "queued": True, "action": action}

    def command_status(self, command_id: str) -> dict[str, Any]:
        with self.command_lock:
            ack = self.command_acks.get(command_id)
        return {"command_id": command_id, "status": "acknowledged" if ack else "pending", "ack": ack}

    def health(self, broker_running: bool) -> dict[str, Any]:
        sim = self.database.get_simulation_state() or {}
        return {
            "ok": broker_running and self.connected.is_set() and self.simulator.connected,
            "mqtt_broker": "connected" if broker_running else "stopped",
            "backend_mqtt_client": "connected" if self.connected.is_set() else "disconnected",
            "device_mqtt_client": "connected" if self.simulator.connected else "disconnected",
            "simulator_running": sim.get("simulator_running", False),
            "device_id": DEVICE_ID,
            "accepted_telemetry": self.accepted_messages,
            "duplicate_telemetry": self.duplicate_messages,
            "rejected_messages": self.rejected_messages,
            "status_messages": self.status_messages,
            "broker_address": f"{MQTT_HOST}:{MQTT_PORT}",
            "demo_data": True,
        }


def async_start_runtime(database: Database) -> MqttRuntime:
    runtime = MqttRuntime(database)
    runtime.start()
    return runtime

