(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const api = async (path, options = {}) => {
    const response = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
    return data;
  };
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
  const fmt = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(digits);
  const faultLabels = {
    healthy: "Healthy baseline",
    sediment_clog: "Sediment clog",
    ro_fouling: "RO scaling / fouling",
    ro_bypass: "RO bypass / O-ring leak",
    pump_wear: "Pump wear",
    uv_ageing: "UV lamp ageing",
    carbon_exhaustion: "Carbon exhaustion estimate",
    sensor_malfunction: "Sensor malfunction",
  };
  const sourceLabels = { municipal: "Municipal-like", tanker: "Tanker-like", borewell: "Borewell-like" };
  let refreshTimer = null;
  let toastTimer = null;
  let busy = false;
  let lastRunId = null;

  function notify(message, error = false) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.toggle("is-error", error);
    node.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("is-visible"), 2600);
  }

  function setConnection(id, label, connected) {
    const node = $(id);
    node.classList.toggle("is-online", connected);
    node.classList.toggle("is-offline", !connected);
    node.innerHTML = `<i></i>${label} ${connected ? "ONLINE" : "OFFLINE"}`;
  }

  function renderHealth(items = []) {
    const labels = {
      sediment: "Sediment",
      carbon: "Carbon",
      ro_membrane: "RO membrane",
      uf: "UF",
      uv: "UV",
    };
    const ordered = ["sediment", "carbon", "ro_membrane", "uf", "uv"];
    const byId = Object.fromEntries(items.map((item) => [item.stage_id, item]));
    $("#filter-health-list").innerHTML = ordered.map((id) => {
      const item = byId[id];
      if (!item) return `<div class="health-row"><div><b class="health-name">${labels[id]}</b><small class="health-status">Waiting</small></div><div class="health-bar unavailable"><i style="width:0%"></i></div><span class="health-percent">—</span><span class="health-rul"><small>RUL</small>—</span></div>`;
      const score = item.health_score;
      const barClass = score == null ? "" : score <= 35 ? "critical" : score <= 72 ? "warning" : "";
      const rul = item.rul_p50_days == null ? "—" : `${fmt(item.rul_p50_days, 0)} d`;
      const rulText = item.rul_p10_days != null && item.rul_p90_days != null
        ? `${fmt(item.rul_p10_days, 0)}–${fmt(item.rul_p90_days, 0)} d` : rul;
      return `<div class="health-row">
        <div><b class="health-name">${labels[id]}</b><small class="health-status">${esc((item.status || "").replaceAll("_", " "))}</small></div>
        <div class="health-bar ${score == null ? "unavailable" : ""}"><i class="${barClass}" style="width:${score ?? 0}%"></i></div>
        <span class="health-percent">${score == null ? "—" : `${fmt(score, 0)}%`}</span>
        <span class="health-rul"><small>${id === "ro_membrane" ? "P10–P90" : "RUL"}</small>${rulText}</span>
      </div>`;
    }).join("");
  }

  function renderPumpComponent(analysis, telemetry) {
    const cause = analysis?.classification?.fault_id;
    const current = telemetry?.measurements?.pump_current_ma;
    const wearDetected = cause === "pump_wear";
    $("#pump-component").innerHTML = `<div class="pump-symbol">P</div>
      <div class="pump-copy"><b>Pump component <span>NOT A FILTER STAGE</span></b><small>${wearDetected ? "Possible wear pattern · synthetic demo scorer" : "No pump-wear pattern currently identified"}</small></div>
      <div class="pump-reading"><small>OPTIONAL CURRENT</small><b>${current == null ? "not fitted" : `${fmt(current,0)} mA`}</b></div>`;
  }

  function renderSensors(telemetry) {
    const m = telemetry?.measurements || {};
    const q = telemetry?.quality || {};
    const values = [
      ["INPUT TDS", m.input_tds_ppm == null ? "—" : `${fmt(m.input_tds_ppm, 0)} ppm`, "base · inlet", false],
      ["OUTPUT TDS", m.output_tds_ppm == null ? "—" : `${fmt(m.output_tds_ppm, 0)} ppm`, "base · output", false],
      ["WATER TEMP", m.water_temp_c == null ? "—" : `${fmt(m.water_temp_c, 1)} °C`, "base · inlet", false],
      ["TANK FILL", m.tank_fill_time_min == null ? "—" : `${fmt(m.tank_fill_time_min, 1)} min`, "float-switch timing", false],
      ["INLET PRESSURE", m.inlet_pressure_mpa == null ? "not fitted" : `${fmt(m.inlet_pressure_mpa, 3)} MPa`, "optional kit", true],
      ["RO PRESSURE", m.ro_pressure_mpa == null ? "not fitted" : `${fmt(m.ro_pressure_mpa, 3)} MPa`, "optional kit", true],
      ["REJECT FLOW", m.reject_flow_lpm == null ? "not fitted" : `${fmt(m.reject_flow_lpm, 3)} L/min`, "optional kit", true],
      ["PUMP CURRENT", m.pump_current_ma == null ? "not fitted" : `${fmt(m.pump_current_ma, 0)} mA`, "optional kit", true],
      ["UV CURRENT", m.uv_current_ma == null ? "not fitted" : `${fmt(m.uv_current_ma, 0)} mA`, "optional kit", true],
      ["PUMP RUNTIME", `${fmt(m.pump_runtime_s, 0)} s`, "controller signal", false],
      ["VALVE / PUMP", `${esc(m.valve_state || "—")} / ${m.pump_on ? "ON" : "OFF"}`, "controller state", false],
      ["TANK FLOAT", esc(m.tank_float_state || "—"), `quality · ${esc(q.operating_state || "—")}`, false],
    ];
    $("#sensor-grid").innerHTML = values.map(([label, value, detail, optional]) => `
      <div class="sensor-cell ${optional ? "optional" : ""}">
        <small>${label}</small><b>${value}</b><span>${detail}</span>
      </div>`).join("");
  }

  function createChart(items, key, color, formatter) {
    const accepted = items.filter((item) =>
      item.quality?.operating_state === "steady" &&
      item.quality?.readings_valid &&
      item.indicators?.[key] != null
    );
    const values = accepted.slice(-32).map((item) => Number(item.indicators[key]));
    if (values.length < 2) return `<div class="empty-chart">${values.length ? "Collecting trend points…" : "Waiting for steady-state history"}</div>`;
    const width = 720, height = 94, left = 34, right = 12, top = 9, bottom = 18;
    const min0 = Math.min(...values), max0 = Math.max(...values);
    const pad = Math.max((max0 - min0) * .18, key === "salt_passage" ? .005 : .025);
    const min = Math.max(0, min0 - pad), max = max0 + pad;
    const innerW = width - left - right, innerH = height - top - bottom;
    const xy = values.map((value, index) => [
      left + innerW * index / (values.length - 1),
      top + innerH * (1 - (value - min) / Math.max(.00001, max - min)),
    ]);
    const path = xy.map(([x,y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const last = xy.at(-1);
    const grid = [0,1,2].map((i) => {
      const y = top + innerH * i / 2;
      return `<path d="M${left} ${y}H${width-right}" stroke="rgba(151,190,203,.1)" stroke-width="1"/>`;
    }).join("");
    const dateTicks = accepted.slice(-32);
    const leftLabel = `day ${fmt(dateTicks[0].simulation_day, 0)}`;
    const rightLabel = `day ${fmt(dateTicks.at(-1).simulation_day, 0)}`;
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${key} trend from ${values.length} accepted readings">
      ${grid}<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="3.2" fill="${color}" stroke="#0c202c" stroke-width="1.5"/>
      <text x="${left}" y="${height-3}" fill="#667f88" font-size="7">${leftLabel}</text>
      <text x="${width-right}" y="${height-3}" text-anchor="end" fill="#667f88" font-size="7">${rightLabel}</text>
      <text x="${left}" y="${top+7}" fill="#69838c" font-size="6">${formatter(max0)}</text>
      <text x="${left}" y="${top+innerH}" fill="#69838c" font-size="6">${formatter(min0)}</text>
    </svg>`;
  }

  function renderCharts(items = []) {
    $("#npf-chart").innerHTML = createChart(items, "normalized_permeate_flow", "#52dfd4", (n) => `NPF ${fmt(n,2)}`);
    $("#salt-chart").innerHTML = createChart(items, "salt_passage", "#66a3ff", (n) => `${fmt(n * 100,2)}%`);
  }

  function renderPrediction(prediction, analysis) {
    if (!prediction) {
      $("#rul-range").innerHTML = `<div class="empty-state compact">${analysis?.classification?.fault_id === "ro_bypass" ? "Possible bypass alert · remaining-life forecast is not applicable." : "Waiting for a valid flow trend."}</div>`;
      $("#rul-range").classList.remove("has-range");
      $("#prediction-window").textContent = "Predicted failure window: —";
      return;
    }
    $("#rul-range").classList.add("has-range");
    $("#rul-range").innerHTML = `<div class="range-header"><span>RO MEMBRANE · DAYS TO CONFIGURED DEMO EOL</span><span>UNCERTAINTY RANGE</span></div>
      <div class="range-bar"><i></i><b class="range-marker p10"></b><b class="range-marker p50"></b><b class="range-marker p90"></b></div>
      <div class="range-labels"><span>P10 · ${fmt(prediction.p10_days,0)}d</span><span class="median">P50 · ${fmt(prediction.p50_days,0)}d</span><span>P90 · ${fmt(prediction.p90_days,0)}d</span></div>`;
    $("#prediction-window").textContent = `Illustrative window: ${prediction.failure_window_start || "—"} → ${prediction.failure_window_end || "—"}`;
  }

  function renderCause(analysis) {
    const result = analysis?.classification;
    if (!result) {
      $("#cause-name").textContent = "No fault pattern yet";
      $("#cause-confidence").textContent = "Synthetic rule-based scorer · not field calibrated";
      $("#cause-evidence").innerHTML = "<li>Evidence will appear after valid telemetry.</li>";
      return;
    }
    $("#cause-name").textContent = result.fault || "No fault pattern stands out";
    const percent = Number.isFinite(Number(result.probability)) ? `${(result.probability * 100).toFixed(0)}% demo score` : "no score";
    $("#cause-confidence").textContent = `${percent} · ${result.model || "demo model"} · not calibrated`;
    const indicators = result.supporting_indicators || [];
    $("#cause-evidence").innerHTML = indicators.length
      ? indicators.slice(0,3).map((item) => `<li>${esc(item)}</li>`).join("")
      : "<li>No configured synthetic fault pattern crossed the review threshold.</li>";
  }

  function renderSourceProfile(analysis) {
    const profile = analysis?.source_profile;
    if (!profile?.inferred) {
      $("#inferred-source").textContent = "Collecting evidence";
      $("#source-confidence").textContent = "—";
      $("#source-posterior").textContent = "Uses configured TDS + temperature distributions; source identity is an inference.";
      return;
    }
    $("#inferred-source").textContent = `${profile.inferred}-like`;
    $("#source-confidence").textContent = `${Math.round(profile.confidence * 100)}%`;
    $("#source-posterior").textContent = Object.entries(profile.posterior || {})
      .map(([key,value]) => `${key} ${Math.round(value * 100)}%`).join(" · ");
  }

  function renderAlerts(items = []) {
    const open = items.filter((item) => !item.acknowledged).length;
    $("#alert-count").textContent = `${open} OPEN`;
    if (!items.length) {
      $("#alert-list").innerHTML = `<div class="empty-state compact">No alerts in this simulation run.</div>`;
      return;
    }
    $("#alert-list").innerHTML = items.slice(0,7).map((item) => {
      const date = item.created_at ? new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      return `<div class="alert-row ${esc(item.severity)}">
        <i class="severity-dot"></i><div><b>${esc(item.alert_type.replaceAll("_"," "))} · ${esc(item.stage_id || "device")}</b>
          <small>${esc(item.description)}</small>${item.acknowledged ? `<small>ACKNOWLEDGED</small>` : `<button class="alert-ack" data-ack="${item.id}">Acknowledge</button>`}
        </div><time>${esc(date)}</time>
      </div>`;
    }).join("");
  }

  function serviceActionMarkup(item) {
    if (item.status === "recommended") return `<button class="button teal" data-service-action="approve" data-id="${esc(item.request_id)}">Approve</button>`;
    if (item.status === "approved" || item.status === "stock_reserved" || item.status === "serviceable") return `<button class="button outline" data-service-action="dispatch" data-id="${esc(item.request_id)}">Check + dispatch</button>`;
    if (item.status === "dispatched") return `<button class="button outline" data-service-action="deliver" data-id="${esc(item.request_id)}">Mark delivered</button>`;
    if (item.status === "delivered") return `<button class="button outline" data-service-action="complete" data-id="${esc(item.request_id)}">Complete replacement</button>`;
    return "";
  }

  function renderService(requests = [], inventory = []) {
    $("#service-count").textContent = `${requests.length} REQUEST${requests.length === 1 ? "" : "S"}`;
    if (!requests.length) {
      $("#service-content").innerHTML = `<div class="empty-state compact">A stage-specific recommendation will create a demo request when configured criteria are met.</div>`;
      return;
    }
    const item = requests[0];
    const stock = inventory.find((entry) => entry.sku === item.sku);
    $("#service-content").innerHTML = `<div class="service-request">
      <div class="request-top"><b>${esc(item.request_id)} · ${esc(item.stage_id.replaceAll("_"," "))}</b><span class="request-state">${esc(item.status.replaceAll("_"," ").toUpperCase())}</span></div>
      <div class="request-details">
        <span>CARTRIDGE SKU<b>${esc(item.sku)}</b></span><span>PINCODE / SERVICE<b>${esc(item.pincode)} · ${item.serviceable == null ? "not checked" : item.serviceable ? "serviceable" : "not serviceable"}</b></span>
        <span>INVENTORY<b>${stock ? `${stock.available_quantity} available` : "SKU not stocked"}</b></span><span>DISPATCH / DELIVERY<b>${esc(item.dispatch_id || "—")} · ${esc(item.delivery_status.replaceAll("_"," "))}</b></span>
        <span>RECOMMENDATION<b>${esc(item.reason)}</b></span><span>DEMO WAREHOUSE<b>${esc(stock?.warehouse || "—")}</b></span>
      </div>
      <div class="service-actions">${serviceActionMarkup(item)}</div>
    </div>`;
  }

  function renderDashboard(data, telemetryData, inventoryData) {
    const sim = data.simulation || {};
    const latest = data.latest_telemetry;
    const analysis = data.latest_analysis;
    const metrics = latest?.indicators || {};
    const measurements = latest?.measurements || {};
    const status = data.runtime || {};
    setConnection("#api-state", "API", true);
    setConnection("#mqtt-state", "MQTT", Boolean(status.mqtt_broker === "connected" && status.backend_mqtt_client === "connected" && status.device_mqtt_client === "connected"));
    $("#device-title").textContent = data.device?.device_id || "AQT-1001";
    $("#device-subtitle").textContent = `${data.device?.customer_name || "Household"} · PIN ${data.device?.pincode || "—"}`;

    if (sim.simulation_run_id && lastRunId && lastRunId !== sim.simulation_run_id) {
      notify("New simulation run started; telemetry history is scoped to the new run.");
    }
    lastRunId = sim.simulation_run_id || lastRunId;

    const activeFault = faultLabels[sim.fault_injection] || sim.fault_injection || "waiting";
    $("#device-state-label").textContent = latest ? activeFault.toUpperCase() : "WAITING FOR DEVICE";
    const stateDot = $("#device-state-dot");
    stateDot.className = activeFault.includes("bypass") || activeFault.includes("malfunction") ? "bad" :
      activeFault !== "Healthy baseline" && latest ? "warning" : latest ? "good" : "";

    const source = sim.source_profile_selected || "municipal";
    $("#source-control").value = source;
    $("#fault-control").value = sim.fault_injection || "healthy";
    $("#source-profile").textContent = analysis?.source_profile?.inferred
      ? `${analysis.source_profile.inferred}-like inferred` : `${sourceLabels[source] || source} selected`;

    $("#kpi-input-tds").textContent = measurements.input_tds_ppm == null ? "—" : fmt(measurements.input_tds_ppm, 0);
    $("#kpi-output-tds").textContent = measurements.output_tds_ppm == null ? "—" : fmt(measurements.output_tds_ppm, 0);
    $("#kpi-salt").textContent = metrics.salt_passage == null ? "—" : fmt(metrics.salt_passage * 100, 2);
    $("#kpi-npf").textContent = metrics.normalized_permeate_flow == null ? "—" : fmt(metrics.normalized_permeate_flow, 3);
    $("#kpi-fill").textContent = measurements.tank_fill_time_min == null ? "—" : fmt(measurements.tank_fill_time_min, 1);
    $("#tank-volume").textContent = measurements.tank_usable_volume_l ? `${fmt(measurements.tank_usable_volume_l,0)} L configured tank` : "Float-switch estimate";
    const tdsTrip = latest?.safety?.output_tds_cutoff_active;
    $("#cutoff-state").textContent = tdsTrip ? "Existing output-TDS cut-off active" : "Cut-off monitored independently";
    $("#cutoff-state").classList.toggle("text-red", Boolean(tdsTrip));
    const quality = latest?.quality;
    const fallback = latest?.edge_state?.fallback_counter_active;
    const qualityLabel = !quality?.readings_valid && fallback
      ? "COUNTER FALLBACK"
      : quality?.readings_valid
      ? quality.operating_state === "steady" ? "VALID · STEADY" : "VALID · TRANSIENT"
      : "SENSOR FAULT";
    $("#kpi-quality").textContent = qualityLabel;
    $("#kpi-quality").className = `quality-value ${!quality?.readings_valid ? "bad" : quality?.operating_state !== "steady" ? "warning" : ""}`;
    $("#steady-state").textContent = fallback
      ? `${fmt(latest.edge_state.fallback_counter_remaining_l,0)} L to configured demo counter limit`
      : quality?.operating_state === "steady"
        ? `${fmt(quality.steady_state_duration_s,0)} s · health eligible` : "Health updates gated until steady";
    $("#device-state-dot").classList.toggle("good", Boolean(status.device_mqtt_client === "connected"));
    $("#health-confidence").textContent = quality?.readings_valid
      ? "Per-stage indicators · update only on accepted steady-state data"
      : "Invalid sensor readings are isolated from filter-fault inference";

    const seen = latest?.timestamp ? new Date(latest.timestamp) : null;
    $("#last-updated").textContent = seen ? `Last edge packet ${seen.toLocaleTimeString()}` : "Waiting for first telemetry…";
    $("#footer-telemetry").textContent = `${data.counts?.telemetry_count ?? 0} messages stored this run · ${status.accepted_telemetry ?? 0} accepted this process`;
    $("#source-confidence").className = analysis?.source_profile?.confidence >= .7 ? "" : "text-amber";
    const activeSafety = Object.entries(latest?.safety || {}).filter(([key,value]) => key.endsWith("_active") && value).map(([key]) => key.replaceAll("_"," "));
    $("#safety-summary").textContent = activeSafety.length
      ? `Active: ${activeSafety.join(", ")}. Predictive advice cannot override an interlock.`
      : "Predictive advice cannot override output-TDS, UV, leak, or dry-run protection.";

    renderHealth(data.filter_health || []);
    renderPumpComponent(analysis, latest);
    renderSensors(latest);
    renderCharts(telemetryData.items || []);
    renderPrediction(data.latest_prediction, analysis);
    renderCause(analysis);
    renderSourceProfile(analysis);
    renderAlerts(data.alerts || []);
    renderService(data.replacement_requests || [], inventoryData.items || []);

    const simStatus = sim.simulator_running ? "PAUSE" : "START";
    $("#pause-button").disabled = !sim.simulator_running;
    $("#start-button").disabled = Boolean(sim.simulator_running);
    $("#pause-button").title = simStatus === "PAUSE" ? "Pause simulator clock" : "Simulation is paused";
    $("#start-button").title = simStatus === "START" ? "Start simulator clock" : "Simulation is already running";
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const [dashboard, telemetryData, inventoryData] = await Promise.all([
        api("/dashboard"), api("/telemetry?limit=80"), api("/inventory"),
      ]);
      renderDashboard(dashboard, telemetryData, inventoryData);
    } catch (error) {
      setConnection("#api-state", "API", false);
      setConnection("#mqtt-state", "MQTT", false);
      $("#last-updated").textContent = "API not reachable";
      notify(error.message, true);
    } finally {
      busy = false;
    }
  }

  async function command(path, body = {}) {
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body) });
      notify(`${path.split("/").at(-1)} command published over MQTT`);
      if (result.command_id) {
        $("#command-message").textContent = `COMMAND ${result.command_id.slice(0,8)} · waiting for device acknowledgement`;
        $("#command-message").classList.add("is-visible");
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 180));
          try {
            const status = await api(`/commands/${encodeURIComponent(result.command_id)}`);
            if (status.status === "acknowledged") {
              const note = status.ack?.message || "device acknowledged";
              $("#command-message").textContent = `COMMAND ${result.command_id.slice(0,8)} · ${note}`;
              notify(`Device acknowledgement · ${note}`);
              break;
            }
          } catch { /* Keep the command queued label; next dashboard refresh still shows device state. */ }
        }
        setTimeout(() => $("#command-message").classList.remove("is-visible"), 3000);
      }
      setTimeout(refresh, 180);
      return result;
    } catch (error) {
      notify(error.message, true);
      return null;
    }
  }

  $("#source-control").addEventListener("change", (event) => command("/simulation/source", { source: event.target.value }));
  $("#fault-control").addEventListener("change", (event) => command("/simulation/fault", { fault: event.target.value }));
  $("#start-button").addEventListener("click", () => command("/simulation/start"));
  $("#pause-button").addEventListener("click", () => command("/simulation/pause"));
  $("#advance-button").addEventListener("click", () => command("/simulation/advance", { days: 10 }));
  $("#scenario-button").addEventListener("click", () => command("/simulation/scenario", { scenario: "hyderabad_tanker_fouling" }));
  $("#reset-button").addEventListener("click", async () => {
    if (confirm("Start a clean demo run and restore the synthetic inventory? Existing telemetry remains in SQLite history.")) {
      await command("/simulation/reset");
    }
  });

  document.addEventListener("click", async (event) => {
    const acknowledge = event.target.closest("[data-ack]");
    if (acknowledge) {
      try {
        await api(`/alerts/${acknowledge.dataset.ack}/acknowledge`, { method: "POST", body: JSON.stringify({ acknowledged_by: "demo-operator" }) });
        notify("Alert acknowledged");
        refresh();
      } catch (error) { notify(error.message, true); }
      return;
    }
    const workflow = event.target.closest("[data-service-action]");
    if (!workflow) return;
    const id = encodeURIComponent(workflow.dataset.id);
    const action = workflow.dataset.serviceAction;
    const path = action === "approve" ? `/service/requests/${id}/approve`
      : action === "dispatch" ? `/service/requests/${id}/dispatch`
        : action === "deliver" ? `/service/requests/${id}/deliver`
          : `/service/requests/${id}/complete`;
    const body = action === "approve" ? { approved_by: "demo-operator" } : {};
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      notify(`Service workflow updated · ${action}`);
      refresh();
    } catch (error) { notify(error.message, true); }
  });

  refresh();
  refreshTimer = setInterval(refresh, 1400);
  window.addEventListener("beforeunload", () => clearInterval(refreshTimer));
})();
