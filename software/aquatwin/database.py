from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import DB_PATH, DEVICE, SIM


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def dump(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


class Database:
    """Small local SQLite repository; telemetry persists across app restarts."""

    def __init__(self, path: Path = DB_PATH) -> None:
        self.path = Path(path)
        self.lock = threading.RLock()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=8.0, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 8000")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.lock, self.connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS devices (
                    device_id TEXT PRIMARY KEY,
                    customer_id TEXT NOT NULL,
                    customer_name TEXT NOT NULL,
                    pincode TEXT NOT NULL,
                    purifier_model TEXT NOT NULL,
                    firmware_version TEXT NOT NULL,
                    installation_date TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'online',
                    last_seen TEXT
                );
                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    timestamp TEXT NOT NULL,
                    operating_state TEXT NOT NULL,
                    readings_valid INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE(device_id, sequence)
                );
                CREATE INDEX IF NOT EXISTS idx_telemetry_run_time
                    ON telemetry(device_id, simulation_run_id, timestamp DESC);
                CREATE TABLE IF NOT EXISTS filter_health (
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    stage_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    health_score REAL,
                    rul_p10_days REAL,
                    rul_p50_days REAL,
                    rul_p90_days REAL,
                    cause TEXT,
                    confidence REAL,
                    evidence TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(device_id, simulation_run_id, stage_id)
                );
                CREATE TABLE IF NOT EXISTS analytics_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(device_id, simulation_run_id, sequence)
                );
                CREATE TABLE IF NOT EXISTS predictions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    stage_id TEXT NOT NULL,
                    p10_days REAL,
                    p50_days REAL,
                    p90_days REAL,
                    failure_window_start TEXT,
                    failure_window_end TEXT,
                    probable_cause TEXT,
                    confidence REAL NOT NULL,
                    model_version TEXT NOT NULL,
                    evidence TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_predictions_device_time
                    ON predictions(device_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    stage_id TEXT,
                    alert_type TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    description TEXT NOT NULL,
                    evidence TEXT NOT NULL,
                    acknowledged INTEGER NOT NULL DEFAULT 0,
                    dedupe_key TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_alerts_run_time
                    ON alerts(device_id, simulation_run_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS source_change_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    previous_profile TEXT,
                    inferred_profile TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    observed_input_tds_ppm REAL NOT NULL,
                    observed_temp_c REAL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS simulation_state (
                    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS inventory (
                    sku TEXT PRIMARY KEY,
                    available_quantity INTEGER NOT NULL CHECK(available_quantity >= 0),
                    warehouse TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS replacement_requests (
                    request_id TEXT PRIMARY KEY,
                    device_id TEXT NOT NULL REFERENCES devices(device_id),
                    simulation_run_id TEXT NOT NULL,
                    stage_id TEXT NOT NULL,
                    sku TEXT NOT NULL,
                    pincode TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    prediction_id INTEGER,
                    status TEXT NOT NULL,
                    approved_by TEXT,
                    serviceable INTEGER,
                    dispatch_id TEXT,
                    delivery_status TEXT NOT NULL DEFAULT 'not_created',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_requests_run_time
                    ON replacement_requests(device_id, simulation_run_id, created_at DESC);
                """
            )
            db.execute(
                """INSERT OR IGNORE INTO devices
                   (device_id, customer_id, customer_name, pincode, purifier_model,
                    firmware_version, installation_date, status, last_seen)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'online', NULL)""",
                (
                    DEVICE["device_id"],
                    DEVICE["customer_id"],
                    DEVICE["customer_name"],
                    DEVICE["pincode"],
                    DEVICE["purifier_model"],
                    DEVICE["firmware_version"],
                    DEVICE["installation_date"],
                ),
            )
            for sku, quantity in SIM["service"]["initial_inventory"].items():
                db.execute(
                    "INSERT OR IGNORE INTO inventory(sku, available_quantity, warehouse, updated_at) VALUES(?,?,?,?)",
                    (sku, quantity, SIM["service"]["warehouse"], now_iso()),
                )

    @staticmethod
    def _decode(row: sqlite3.Row | None, column: str = "payload") -> dict[str, Any] | None:
        if row is None:
            return None
        return json.loads(row[column])

    def insert_telemetry(self, payload: dict[str, Any]) -> bool:
        timestamp = payload["timestamp"]
        if isinstance(timestamp, datetime):
            timestamp = timestamp.isoformat()
        with self.lock, self.connect() as db:
            cursor = db.execute(
                """INSERT OR IGNORE INTO telemetry
                   (device_id, simulation_run_id, sequence, timestamp, operating_state, readings_valid, payload)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    payload["device_id"],
                    payload["simulation_run_id"],
                    payload["sequence"],
                    timestamp,
                    payload["quality"]["operating_state"],
                    int(payload["quality"]["readings_valid"]),
                    dump(payload),
                ),
            )
            if cursor.rowcount:
                db.execute(
                    "UPDATE devices SET status='online', last_seen=? WHERE device_id=?",
                    (timestamp, payload["device_id"]),
                )
            return cursor.rowcount > 0

    def latest_sequence(self, device_id: str) -> int:
        with self.connect() as db:
            row = db.execute("SELECT MAX(sequence) AS sequence FROM telemetry WHERE device_id=?", (device_id,)).fetchone()
        return int(row["sequence"] or 0)

    def recent_telemetry(self, device_id: str, run_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute(
                """SELECT payload FROM telemetry
                   WHERE device_id=? AND simulation_run_id=?
                   ORDER BY sequence DESC LIMIT ?""",
                (device_id, run_id, limit),
            ).fetchall()
        return [json.loads(row["payload"]) for row in reversed(rows)]

    def get_simulation_state(self) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT payload FROM simulation_state WHERE singleton_id=1").fetchone()
        return self._decode(row)

    def set_simulation_state(self, payload: dict[str, Any]) -> None:
        with self.lock, self.connect() as db:
            db.execute(
                """INSERT INTO simulation_state(singleton_id,payload,updated_at) VALUES(1,?,?)
                   ON CONFLICT(singleton_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at""",
                (dump(payload), now_iso()),
            )

    def save_analysis(
        self,
        device_id: str,
        run_id: str,
        analysis: dict[str, Any],
        *,
        source_event: dict[str, Any] | None = None,
        edge_event: dict[str, Any] | None = None,
    ) -> int | None:
        timestamp = now_iso()
        prediction = analysis["prediction"]
        with self.lock, self.connect() as db:
            sequence = int(analysis.get("sequence", 0))
            db.execute(
                """INSERT OR IGNORE INTO analytics_snapshots
                   (device_id,simulation_run_id,sequence,payload,created_at) VALUES(?,?,?,?,?)""",
                (device_id, run_id, sequence, dump(analysis), timestamp),
            )
            for stage in analysis["filter_health"]:
                db.execute(
                    """INSERT INTO filter_health
                       (device_id,simulation_run_id,stage_id,status,health_score,rul_p10_days,rul_p50_days,rul_p90_days,
                        cause,confidence,evidence,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(device_id,simulation_run_id,stage_id) DO UPDATE SET
                         status=excluded.status,health_score=excluded.health_score,
                         rul_p10_days=excluded.rul_p10_days,rul_p50_days=excluded.rul_p50_days,
                         rul_p90_days=excluded.rul_p90_days,cause=excluded.cause,
                         confidence=excluded.confidence,evidence=excluded.evidence,updated_at=excluded.updated_at""",
                    (
                        device_id, run_id, stage["stage_id"], stage["status"], stage.get("health_score"),
                        stage.get("rul_p10_days"), stage.get("rul_p50_days"), stage.get("rul_p90_days"),
                        stage.get("probable_cause"), stage.get("confidence", 0.0), dump(stage.get("evidence", [])), timestamp,
                    ),
                )

            prediction_id: int | None = None
            if prediction:
                cursor = db.execute(
                    """INSERT INTO predictions
                       (device_id,simulation_run_id,stage_id,p10_days,p50_days,p90_days,
                        failure_window_start,failure_window_end,probable_cause,confidence,model_version,evidence,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        device_id, run_id, prediction["stage_id"], prediction.get("p10_days"),
                        prediction.get("p50_days"), prediction.get("p90_days"),
                        prediction.get("failure_window_start"), prediction.get("failure_window_end"),
                        prediction.get("probable_cause"), prediction.get("confidence", 0.0),
                        prediction["model_version"], dump(prediction.get("evidence", [])), timestamp,
                    ),
                )
                prediction_id = int(cursor.lastrowid)

            for alert in analysis.get("alerts", []):
                dedupe_key = f"{run_id}:{alert['alert_type']}:{alert.get('stage_id') or 'device'}"
                db.execute(
                    """INSERT OR IGNORE INTO alerts
                       (device_id,simulation_run_id,stage_id,alert_type,severity,description,evidence,dedupe_key,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        device_id, run_id, alert.get("stage_id"), alert["alert_type"],
                        alert["severity"], alert["description"], dump(alert.get("evidence", [])),
                        dedupe_key, timestamp,
                    ),
                )

            if source_event:
                db.execute(
                    """INSERT INTO source_change_events
                       (device_id,simulation_run_id,previous_profile,inferred_profile,confidence,
                        observed_input_tds_ppm,observed_temp_c,created_at)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    (
                        device_id, run_id, source_event.get("previous_profile"), source_event["inferred_profile"],
                        source_event["confidence"], source_event["observed_input_tds_ppm"],
                        source_event.get("observed_temp_c"), timestamp,
                    ),
                )
            if edge_event:
                dedupe_key = f"{run_id}:{edge_event['type']}:ro_membrane"
                db.execute(
                    """INSERT OR IGNORE INTO alerts
                       (device_id,simulation_run_id,stage_id,alert_type,severity,description,evidence,dedupe_key,created_at)
                       VALUES(?,?,?,?,?,?,?,?,?)""",
                    (
                        device_id, run_id, "ro_membrane", edge_event["type"], edge_event["severity"],
                        edge_event["description"], dump([]), dedupe_key, timestamp,
                    ),
                )

            recommended = analysis.get("replacement_recommendation")
            if recommended:
                active = db.execute(
                    """SELECT request_id FROM replacement_requests
                       WHERE device_id=? AND simulation_run_id=? AND stage_id=?
                         AND status NOT IN ('replaced','cancelled') LIMIT 1""",
                    (device_id, run_id, recommended["stage_id"]),
                ).fetchone()
                if not active:
                    stage_codes = {
                        "ro_membrane": "RO",
                        "sediment": "SED",
                        "carbon": "CAR",
                        "uv": "UV",
                    }
                    request_id = f"REQ-{run_id[-6:].upper()}-{stage_codes.get(recommended['stage_id'], 'FLT')}"
                    db.execute(
                        """INSERT OR IGNORE INTO replacement_requests
                           (request_id,device_id,simulation_run_id,stage_id,sku,pincode,reason,
                            prediction_id,status,created_at,updated_at)
                           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            request_id, device_id, run_id, recommended["stage_id"], recommended["sku"],
                            recommended["pincode"], recommended["reason"],
                            prediction_id if recommended["stage_id"] == "ro_membrane" else None,
                            "recommended", timestamp, timestamp,
                        ),
                    )
            return prediction_id

    def dashboard(self) -> dict[str, Any]:
        sim = self.get_simulation_state() or {}
        run_id = sim.get("simulation_run_id", "")
        device_id = DEVICE["device_id"]
        with self.connect() as db:
            device_row = db.execute("SELECT * FROM devices WHERE device_id=?", (device_id,)).fetchone()
            latest_row = db.execute(
                """SELECT payload FROM telemetry WHERE device_id=? AND simulation_run_id=?
                   ORDER BY sequence DESC LIMIT 1""",
                (device_id, run_id),
            ).fetchone()
            health_rows = db.execute(
                "SELECT * FROM filter_health WHERE device_id=? AND simulation_run_id=? ORDER BY stage_id",
                (device_id, run_id),
            ).fetchall()
            prediction_row = db.execute(
                """SELECT * FROM predictions WHERE device_id=? AND simulation_run_id=?
                   ORDER BY id DESC LIMIT 1""",
                (device_id, run_id),
            ).fetchone()
            analysis_row = db.execute(
                """SELECT payload FROM analytics_snapshots WHERE device_id=? AND simulation_run_id=?
                   ORDER BY sequence DESC LIMIT 1""",
                (device_id, run_id),
            ).fetchone()
            alert_rows = db.execute(
                """SELECT * FROM alerts WHERE device_id=? AND simulation_run_id=?
                   ORDER BY id DESC LIMIT 8""",
                (device_id, run_id),
            ).fetchall()
            request_rows = db.execute(
                """SELECT * FROM replacement_requests WHERE device_id=? AND simulation_run_id=?
                   ORDER BY created_at DESC""",
                (device_id, run_id),
            ).fetchall()
            counts = db.execute(
                """SELECT COUNT(*) AS total,
                          SUM(CASE WHEN acknowledged=0 THEN 1 ELSE 0 END) AS unacknowledged
                   FROM alerts WHERE device_id=? AND simulation_run_id=?""",
                (device_id, run_id),
            ).fetchone()

        def row_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
            return dict(row) if row else None

        latest = self._decode(latest_row)
        prediction = row_dict(prediction_row)
        if prediction:
            prediction["evidence"] = json.loads(prediction["evidence"])
        health = []
        for row in health_rows:
            value = dict(row)
            value["evidence"] = json.loads(value["evidence"])
            health.append(value)
        alerts = []
        for row in alert_rows:
            value = dict(row)
            value["evidence"] = json.loads(value["evidence"])
            alerts.append(value)
        return {
            "demo_data": True,
            "device": row_dict(device_row),
            "simulation": sim,
            "latest_telemetry": latest,
            "filter_health": health,
            "latest_prediction": prediction,
            "latest_analysis": self._decode(analysis_row),
            "alerts": alerts,
            "replacement_requests": [dict(row) for row in request_rows],
            "alert_counts": {"total": counts["total"] or 0, "unacknowledged": counts["unacknowledged"] or 0},
        }

    def telemetry(self, limit: int = 100) -> list[dict[str, Any]]:
        sim = self.get_simulation_state() or {}
        return self.recent_telemetry(DEVICE["device_id"], sim.get("simulation_run_id", ""), max(1, min(limit, 1000)))

    def prediction_history(self, limit: int = 50) -> list[dict[str, Any]]:
        sim = self.get_simulation_state() or {}
        with self.connect() as db:
            rows = db.execute(
                """SELECT * FROM predictions WHERE device_id=? AND simulation_run_id=?
                   ORDER BY id DESC LIMIT ?""",
                (DEVICE["device_id"], sim.get("simulation_run_id", ""), max(1, min(limit, 250))),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["evidence"] = json.loads(item["evidence"])
            result.append(item)
        return result

    def alerts(self, limit: int = 100) -> list[dict[str, Any]]:
        sim = self.get_simulation_state() or {}
        with self.connect() as db:
            rows = db.execute(
                """SELECT * FROM alerts WHERE device_id=? AND simulation_run_id=?
                   ORDER BY id DESC LIMIT ?""",
                (DEVICE["device_id"], sim.get("simulation_run_id", ""), max(1, min(limit, 250))),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["evidence"] = json.loads(item["evidence"])
            result.append(item)
        return result

    def source_events(self, limit: int = 50) -> list[dict[str, Any]]:
        sim = self.get_simulation_state() or {}
        with self.connect() as db:
            rows = db.execute(
                """SELECT * FROM source_change_events WHERE device_id=? AND simulation_run_id=?
                   ORDER BY id DESC LIMIT ?""",
                (DEVICE["device_id"], sim.get("simulation_run_id", ""), max(1, min(limit, 100))),
            ).fetchall()
        return [dict(row) for row in rows]

    def inventory(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM inventory ORDER BY sku").fetchall()
        return [dict(row) for row in rows]

    def reset_inventory(self) -> None:
        with self.lock, self.connect() as db:
            for sku, quantity in SIM["service"]["initial_inventory"].items():
                db.execute(
                    """INSERT INTO inventory(sku,available_quantity,warehouse,updated_at) VALUES(?,?,?,?)
                       ON CONFLICT(sku) DO UPDATE SET available_quantity=excluded.available_quantity,
                       warehouse=excluded.warehouse,updated_at=excluded.updated_at""",
                    (sku, quantity, SIM["service"]["warehouse"], now_iso()),
                )

    def service_requests(self) -> list[dict[str, Any]]:
        sim = self.get_simulation_state() or {}
        with self.connect() as db:
            rows = db.execute(
                """SELECT * FROM replacement_requests WHERE device_id=? AND simulation_run_id=?
                   ORDER BY created_at DESC""",
                (DEVICE["device_id"], sim.get("simulation_run_id", "")),
            ).fetchall()
        return [dict(row) for row in rows]

    def get_request(self, request_id: str) -> dict[str, Any] | None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM replacement_requests WHERE request_id=?", (request_id,)).fetchone()
        return dict(row) if row else None

    def approve_request(self, request_id: str, approved_by: str) -> dict[str, Any] | None:
        with self.lock, self.connect() as db:
            row = db.execute("SELECT * FROM replacement_requests WHERE request_id=?", (request_id,)).fetchone()
            if row is None:
                return None
            if row["status"] == "approved":
                return dict(row)
            if row["status"] != "recommended":
                raise ValueError(f"Cannot approve a request in state '{row['status']}'")
            db.execute(
                "UPDATE replacement_requests SET status='approved', approved_by=?, updated_at=? WHERE request_id=?",
                (approved_by, now_iso(), request_id),
            )
        return self.get_request(request_id)

    def dispatch_request(self, request_id: str) -> tuple[dict[str, Any] | None, str | None]:
        error: str | None = None
        with self.lock, self.connect() as db:
            row = db.execute("SELECT * FROM replacement_requests WHERE request_id=?", (request_id,)).fetchone()
            if row is None:
                return None, "request_not_found"
            request = dict(row)
            if request["status"] not in ("approved", "stock_reserved", "serviceable"):
                return request, "approval_required"
            if request["pincode"] not in SIM["service"]["serviceable_pincodes"]:
                db.execute(
                    "UPDATE replacement_requests SET status='not_serviceable', serviceable=0, updated_at=? WHERE request_id=?",
                    (now_iso(), request_id),
                )
                error = "pincode_not_serviceable"
            else:
                stock = db.execute(
                    "SELECT available_quantity FROM inventory WHERE sku=?",
                    (request["sku"],),
                ).fetchone()
            if error is None and (stock is None or stock["available_quantity"] < 1):
                db.execute(
                    "UPDATE replacement_requests SET status='out_of_stock', serviceable=1, updated_at=? WHERE request_id=?",
                    (now_iso(), request_id),
                )
                error = "cartridge_out_of_stock"
            if error is None:
                dispatch_id = request.get("dispatch_id") or f"DSP-{request_id[-10:]}"
                if not request.get("dispatch_id"):
                    db.execute(
                        "UPDATE inventory SET available_quantity=available_quantity-1, updated_at=? WHERE sku=?",
                        (now_iso(), request["sku"]),
                    )
                db.execute(
                    """UPDATE replacement_requests SET status='dispatched',serviceable=1,
                       dispatch_id=?,delivery_status='in_transit',updated_at=? WHERE request_id=?""",
                    (dispatch_id, now_iso(), request_id),
                )
        return self.get_request(request_id), error

    def deliver_request(self, request_id: str) -> dict[str, Any] | None:
        with self.lock, self.connect() as db:
            row = db.execute("SELECT * FROM replacement_requests WHERE request_id=?", (request_id,)).fetchone()
            if row is None:
                return None
            if row["status"] == "delivered":
                return dict(row)
            if row["status"] != "dispatched":
                raise ValueError(f"Cannot mark delivery for a request in state '{row['status']}'")
            db.execute(
                """UPDATE replacement_requests SET status='delivered',delivery_status='delivered',updated_at=?
                   WHERE request_id=?""",
                (now_iso(), request_id),
            )
        return self.get_request(request_id)

    def complete_replacement(self, request_id: str) -> dict[str, Any] | None:
        with self.lock, self.connect() as db:
            row = db.execute("SELECT * FROM replacement_requests WHERE request_id=?", (request_id,)).fetchone()
            if row is None:
                return None
            if row["status"] != "delivered":
                return dict(row)
            db.execute(
                "UPDATE replacement_requests SET status='replaced',updated_at=? WHERE request_id=?",
                (now_iso(), request_id),
            )
        return self.get_request(request_id)

    def acknowledge_alert(self, alert_id: int) -> dict[str, Any] | None:
        with self.lock, self.connect() as db:
            db.execute("UPDATE alerts SET acknowledged=1 WHERE id=?", (alert_id,))
            row = db.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone()
        return dict(row) if row else None

    def counts(self) -> dict[str, int]:
        state = self.get_simulation_state() or {}
        run_id = state.get("simulation_run_id", "")
        with self.connect() as db:
            alerts = db.execute(
                "SELECT COUNT(*) AS n FROM alerts WHERE simulation_run_id=? AND acknowledged=0",
                (run_id,),
            ).fetchone()["n"]
            requests = db.execute(
                "SELECT COUNT(*) AS n FROM replacement_requests WHERE simulation_run_id=? AND status NOT IN ('replaced','cancelled')",
                (run_id,),
            ).fetchone()["n"]
            telemetry = db.execute(
                "SELECT COUNT(*) AS n FROM telemetry WHERE simulation_run_id=?",
                (run_id,),
            ).fetchone()["n"]
        return {"active_alerts": alerts, "active_service_requests": requests, "telemetry_count": telemetry}

