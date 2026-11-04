from __future__ import annotations

from .config import DEVICE_ID

ROOT = "aquatwin/v1/devices"


def topic(device_id: str, stream: str) -> str:
    return f"{ROOT}/{device_id}/{stream}"


TELEMETRY_TOPIC = topic(DEVICE_ID, "telemetry")
EVENTS_TOPIC = topic(DEVICE_ID, "events")
COMMAND_TOPIC = topic(DEVICE_ID, "commands")
ACK_TOPIC = topic(DEVICE_ID, "command-acks")
STATUS_TOPIC = topic(DEVICE_ID, "status")
