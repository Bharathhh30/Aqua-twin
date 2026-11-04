from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PACKAGE_DIR = Path(__file__).resolve().parent
SOFTWARE_DIR = PACKAGE_DIR.parent
PROJECT_DIR = SOFTWARE_DIR if (SOFTWARE_DIR / "index.html").exists() else SOFTWARE_DIR.parent
CONFIG_PATH = SOFTWARE_DIR / "config" / "demo.json"
DB_PATH = Path(__import__("os").environ.get("AQUATWIN_DB_PATH", SOFTWARE_DIR / "data" / "aquatwin-demo.sqlite3"))


def load_config() -> dict[str, Any]:
    with CONFIG_PATH.open("r", encoding="utf-8") as file:
        return json.load(file)


CONFIG = load_config()
DEVICE = CONFIG["device"]
SIM = CONFIG["simulation"]
DEVICE_ID = DEVICE["device_id"]
MQTT_HOST = __import__("os").environ.get("AQUATWIN_MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(__import__("os").environ.get("AQUATWIN_MQTT_PORT", "18883"))
