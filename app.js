/* AquaTwin interactive product walkthrough
 * Browser-only, deterministic demo. Values and analytics are synthetic illustrations,
 * not calibrated device behavior or validated model output.
 */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const pad2 = (value) => String(value).padStart(2, "0");

const SOURCE_PROFILES = {
  municipal: { label: "Municipal water", feedTds: 320, temperature: 24, variability: "LOW", profile: "municipal-like" },
  tanker: { label: "Tanker water", feedTds: 650, temperature: 28, variability: "MEDIUM", profile: "tanker-like" },
  borewell: { label: "Borewell water", feedTds: 850, temperature: 25, variability: "HIGH", profile: "borewell-like" },
};

const FAULTS = {
  healthy: { label: "Healthy purifier", short: "Healthy", detail: "Baseline operating profile; no injected fault." },
  "sediment-clog": { label: "Sediment clog", short: "Sediment clog", detail: "Tank fill time rises; optional inlet pressure drop rises; salt passage stays comparatively stable." },
  "ro-fouling": { label: "RO scaling / fouling", short: "RO fouling", detail: "Normalized permeate flow trends down while salt passage trends upward." },
  "ro-bypass": { label: "RO bypass / O-ring leak", short: "RO bypass", detail: "A sudden salt-passage increase suggests a possible bypass; confirm with service inspection." },
  "pump-wear": { label: "Pump wear", short: "Pump wear", detail: "Simulated pump current increases for comparable operating conditions; optional current sensing is needed." },
  "uv-ageing": { label: "UV lamp ageing", short: "UV ageing", detail: "Lamp current / burn-hour proxy indicates reduced UV component health." },
  "carbon-exhaustion": { label: "Carbon exhaustion", short: "Carbon exhausted", detail: "Estimated from use and source assumptions; no direct chlorine sensor is present in the base signal set." },
  "sensor-malfunction": { label: "Sensor malfunction", short: "Sensor fault", detail: "An invalid/stuck measurement is isolated; confidence falls and the configured counter fallback is used." },
};

const PARTS = {
  inlet: {
    name: "Inlet",
    kind: "Water entry · not a filter",
    function: "Receives incoming household water and establishes the feed-water context.",
    failure: "Source variability or a sudden feed-quality change can alter downstream loading.",
    measure: "Input TDS and water temperature; optional inlet pressure.",
    approach: "Track the feed baseline and flag a possible source change using a pattern, not TDS alone.",
  },
  sediment: {
    name: "Sediment",
    kind: "Filtration stage 01",
    function: "Captures suspended particles before they reach the carbon stage and membrane.",
    failure: "Progressive clogging can restrict flow and lengthen tank filling time.",
    measure: "Tank-fill/permeate-flow trend; optional inlet-side pressure measurement.",
    approach: "Look for slower filling with salt passage comparatively unchanged; keep sensor faults separate.",
  },
  carbon: {
    name: "Carbon",
    kind: "Filtration stage 02",
    function: "Reduces chlorine and selected compounds that may damage the RO membrane.",
    failure: "Adsorption capacity can be exhausted with processed volume and water chemistry.",
    measure: "Use estimate from volume and source assumptions; no direct chlorine measurement in the base kit.",
    approach: "Show an estimate with lower confidence rather than claiming direct carbon-health measurement.",
  },
  pump: {
    name: "Pump",
    kind: "Pressurization component · not a filter",
    function: "Creates pressure to drive water through the RO membrane.",
    failure: "Wear can reduce delivered pressure or increase current draw.",
    measure: "Pump runtime; optional pressure and current signals.",
    approach: "Compare current under comparable simulated pressure/flow conditions when kit sensors exist.",
  },
  ro: {
    name: "RO membrane",
    kind: "Filtration stage 03",
    function: "Separates dissolved salts from permeate and reject streams.",
    failure: "Scaling/fouling trends gradually; a bypass or O-ring leak can create an abrupt quality change.",
    measure: "Input/output TDS, temperature, fill-time-derived flow; optional pressure and reject flow.",
    approach: "Trend normalized flow and salt passage; estimate hidden fouling and forecast an uncertainty range.",
  },
  uf: {
    name: "UF",
    kind: "Filtration stage 04",
    function: "Provides a downstream physical barrier in purifier configurations that include UF.",
    failure: "May clog or lose integrity; available base signals do not support a dedicated UF life model.",
    measure: "Indirect flow behavior and manufacturer/service records; no dedicated UF sensor in this demo.",
    approach: "Represent as a stage in the flow path, but do not invent a standalone UF prediction.",
  },
  uv: {
    name: "UV treatment",
    kind: "Treatment stage 05",
    function: "Applies UV treatment when the installed purifier configuration includes a UV lamp.",
    failure: "Lamp output can age; a failed lamp may trigger the purifier's existing lockout.",
    measure: "Burn hours; optional lamp-current measurement and switching count.",
    approach: "Estimate lamp ageing from available signals while leaving UV safety interlocks independent.",
  },
  mineral: {
    name: "Mineral stage",
    kind: "Conditioning stage",
    function: "Adds or adjusts minerals after treatment in configurations that include this stage.",
    failure: "Performance can change with media use and service interval.",
    measure: "Service history and configuration; not directly inferred from the listed base sensors.",
    approach: "Show the stage and its role without claiming an unsupported predictive model.",
  },
  tank: {
    name: "Storage tank",
    kind: "Storage · not a filter",
    function: "Stores treated water; float-switch transitions provide tank-state and timing information.",
    failure: "Unexpected fill duration can indicate upstream restriction, operating changes, or a sensor issue.",
    measure: "Float state and fill duration; an 8 L example is stated in the project PDF.",
    approach: "Use fill time as a flow proxy only with configured usable volume and fill-state assumptions.",
  },
};

const SENSORS = {
  "input-tds": { name: "Input TDS", measure: "Dissolved-solids proxy", unit: "ppm", location: "Inlet", example: "650 ppm", why: "Feed context for salt-passage calculations and possible source-change detection." },
  temperature: { name: "Water temperature", measure: "Feed-water temperature", unit: "°C", location: "Inlet", example: "28 °C", why: "Used by the temperature correction factor before comparing flow performance." },
  "inlet-pressure": { name: "Inlet pressure", measure: "Inlet pressure", unit: "MPa", location: "Before pump / prefilter path", example: "Optional kit", why: "Can help distinguish a restriction from membrane performance changes." },
  "pump-current": { name: "Pump current", measure: "Electrical current", unit: "mA", location: "Pump", example: "Optional kit", why: "Supports pump-wear diagnosis when compared under similar load conditions." },
  "ro-pressure": { name: "RO pressure", measure: "Operating pressure", unit: "MPa", location: "RO feed / reject side", example: "Optional kit", why: "A configured pressure model contributes to net-driving-pressure estimation." },
  "reject-flow": { name: "Reject flow", measure: "Reject-side flow", unit: "L/min", location: "RO reject side", example: "Optional kit", why: "Adds context to membrane performance and water balance." },
  "uv-current": { name: "UV lamp current", measure: "Lamp current", unit: "mA", location: "UV stage", example: "Optional kit", why: "Can support lamp-ageing estimation alongside burn hours and switching count." },
  "output-tds": { name: "Output TDS", measure: "Permeate dissolved-solids proxy", unit: "ppm", location: "Output / tank line", example: "35 ppm", why: "Combined with valid input TDS, supports salt-passage trending and existing safety behavior." },
  "fill-time": { name: "Tank fill time", measure: "Float-switch timing", unit: "minutes", location: "Storage tank", example: "38 min", why: "Provides a flow proxy when usable tank volume and fill transitions are configured." },
  "pump-runtime": { name: "Pump runtime", measure: "Cycle runtime", unit: "seconds", location: "Pump controller signal", example: "240 s", why: "Separates pump startup/transient time from stable operating measurements." },
  "valve-state": { name: "Valve state", measure: "Operating mode", unit: "state", location: "Purifier controller", example: "Purifying", why: "Contextualizes readings so the edge layer does not treat idle or flush behavior as steady purification." },
  "pump-state": { name: "Pump state", measure: "Operating state", unit: "boolean", location: "Pump controller signal", example: "ON", why: "Defines whether run-time sampling and steady-state checks should be active." },
  "tank-float": { name: "Tank float state", measure: "Float-switch state", unit: "state", location: "Storage tank", example: "Filling", why: "Provides the transition timing used to estimate a tank-fill duration." },
};

const SCENES = [
  {
    title: "Replacement is still mostly a calendar guess.",
    kicker: "01 · THE PROBLEM",
    zone: "home",
    lead: "Two homes can use the same purifier for the same time—and have very different filter health.",
    foot: "A source change, a clog, or a small bypass can move the failure date.",
    tags: ["Fixed interval", "Variable water", "Hidden degradation"],
    notes: "Open with the mismatch: purifier life is commonly represented by elapsed time or litres, but actual loading depends on source water and component condition. AquaTwin is an advisory layer that measures performance rather than replacing safety controls.",
    blueprint: "Future product question: what native purifier signals and service history can each OEM expose? Keep the counter-based fallback available when readings are invalid.",
    visual: "problem",
  },
  {
    title: "Start with the real water path.",
    kicker: "02 · PHYSICAL SYSTEM",
    zone: "home",
    lead: "AquaTwin follows the purifier from inlet to tank—so a symptom can be related to the stage that may cause it.",
    foot: "Select a component to inspect its job, likely failure pattern, and available evidence.",
    tags: ["One device", "Nine flow components", "One shared model"],
    notes: "Walk left to right through the physical order. The inlet and tank are not filters. The pump is a pressurization component, not a filtration stage. UF and mineral stage are shown because they may appear in purifier configurations; the available base signals do not justify inventing a dedicated UF model.",
    blueprint: "The SVG component IDs map to future device configuration, serviceable module definitions, and stage-specific health APIs.",
    visual: "purifier",
  },
  {
    title: "Each stage has a different failure story.",
    kicker: "03 · COMPONENT EXPLORER",
    zone: "home",
    lead: "A slow fill is not automatically a membrane problem. The indicators have to be interpreted together.",
    foot: "Choose sediment, RO, pump, UV, or another component in the drawing.",
    tags: ["Stage-specific evidence", "Explainable diagnosis"],
    notes: "Use the selector to show that sediment restriction, RO fouling, pump wear, and an O-ring bypass have different signal patterns. Carbon exhaustion is estimated, while pump is not a filter and UF has no standalone life model in this signal set.",
    blueprint: "Each selected component can evolve into a typed backend entity with its supported signals, estimator, safety relationship, and replacement SKU.",
    visual: "parts",
  },
  {
    title: "The signal begins at a physical location.",
    kicker: "04 · MEASUREMENT LAYER",
    zone: "home",
    lead: "TDS, temperature, pressure, current, and fill timing describe different parts of the process.",
    foot: "Select a marker. Optional sensor-kit readings are visibly separated from base signals.",
    tags: ["Input ≠ output", "Existing vs optional kit"],
    notes: "The original concept emphasizes existing purifier signals: input/output TDS, temperature, pump runtime, valve/mode, and tank fill timing. Pressure, reject flow, and current measurements belong to an optional kit. TDS probes are measurement points, not filtration stages.",
    blueprint: "Sensor contracts should include timestamp, unit, quality status, calibration metadata, and whether a value is native or optional.",
    visual: "sensors",
  },
  {
    title: "A small controller turns readings into context.",
    kicker: "05 · EDGE DEVICE",
    zone: "edge",
    lead: "The intended ESP32-S3 layer checks signals and summarizes purifier behavior close to the device.",
    foot: "This is a software illustration of the intended edge role—not physical firmware.",
    tags: ["Validate", "Steady-state gate", "Summarize"],
    notes: "Clarify the distinction: ESP32-S3 is hardware; ESP-IDF is its firmware framework. This project walkthrough simulates the device behavior in browser JavaScript and does not claim to run ESP-IDF.",
    blueprint: "Keep raw 1 Hz sampling local by default. Define versioned edge telemetry and keep high-frequency raw readings out of routine cloud publishing.",
    visual: "edge",
  },
  {
    title: "Correct the measurement before comparing it.",
    kicker: "06 · EDGE PROCESSING",
    zone: "edge",
    lead: "Temperature, feed quality, and operating pressure all affect the observed membrane behavior.",
    foot: "Example: 650 ppm in, 35 ppm out, 28 °C. NPF waits for configured flow and NDP inputs.",
    tags: ["TCF", "Salt passage", "Normalized flow", "Three-state EKF"],
    notes: "Formula walkthrough: TCF = exp[2640 × (1/298 − 1/(273 + T))]; salt passage = TDSout/TDSin; NPF = Qp × (NDPref/NDP)/TCF. At 28 °C the given TCF is about 1.092. 35/650 is about 5.38%. NPF cannot be responsibly shown as a computed number until Qp, current NDP, and reference NDP are supplied. These can be entered in the configuration fields in this scene.",
    blueprint: "Keep equations, units, reference conditions, and calibration provenance together. EKF states are fouling resistance, fouling growth rate, and TDS-sensor offset; covariance tuning remains a calibration task.",
    visual: "formulas",
  },
  {
    title: "Only a summary needs to travel.",
    kicker: "07 · MQTT TRANSPORT",
    zone: "mqtt",
    lead: "The edge publishes versioned telemetry; MQTT carries it to subscribers without doing the analytics itself.",
    foot: "The animated packet is a payload summary—not a stream of every raw sample.",
    tags: ["Device topic", "QoS / retry concept", "Cloud subscriber"],
    notes: "Show the flow: sensor simulator → edge summary → MQTT publisher → broker → backend subscriber. The broker distributes messages; it is not a prediction engine. The PDF's approximately 2 KB/day is a target for summarized transmission; a live demo may use a higher display cadence.",
    blueprint: "Topic convention: aquatwin/v1/devices/{device_id}/telemetry. Future implementation needs schema validation, timestamps, device identity, reconnection, deduplication, and command acknowledgements.",
    visual: "mqtt",
  },
  {
    title: "Cloud services connect history to action.",
    kicker: "08 · CLOUD ARCHITECTURE",
    zone: "cloud",
    lead: "Historical telemetry, device records, analytics, and service workflow are separate responsibilities.",
    foot: "The dashboard reads derived backend outputs; it does not own the model.",
    tags: ["FastAPI concept", "Time-series history", "Workflow boundary"],
    notes: "A future backend can separate ingestion, analytics, and service workflow modules even if they ship in one modular service. TimescaleDB is proposed for time-series data. Simulation controls in this browser mock change local shared state, not a real cloud device.",
    blueprint: "The architecture ribbon and cards correspond to future API boundaries, database entities, worker jobs, and MQTT topic contracts.",
    visual: "cloud",
  },
  {
    title: "Four analytics answer four different questions.",
    kicker: "09 · PREDICTIVE ANALYTICS",
    zone: "cloud",
    lead: "Estimate hidden degradation, forecast uncertainty, classify a likely cause, and detect a changed input pattern.",
    foot: "Every output shown here is illustrative synthetic behavior—not validated field accuracy.",
    tags: ["Edge EKF", "Cloud particle filter", "Fault classifier", "Change point"],
    notes: "EKF: edge estimate of hidden fouling state. Particle filter: cloud remaining-life distribution using recent household use, with P10/P50/P90. Gradient-boosted classifier: synthetic fault labels and supporting indicators. Bayesian change-point: possible shift in feed TDS level/variation and temperature; it does not prove municipal/tanker/borewell identity from TDS alone.",
    blueprint: "Keep model version, evidence window, uncertainty, sensor quality, and model provenance in the future prediction response. Synthetic training accuracy must never be reported as field validation.",
    visual: "analytics",
  },
  {
    title: "A recommendation is a range, not a promise.",
    kicker: "10 · FILTER HEALTH",
    zone: "cloud",
    lead: "Each supported stage has its own evidence, state, and uncertainty-aware service window.",
    foot: "The illustrative RO forecast is P10 30 · P50 38 · P90 47 days.",
    tags: ["Per-stage state", "Uncertainty range", "Advisory only"],
    notes: "The numbers are illustrative targets for the walkthrough. Replacement criteria should use configured stage-specific performance thresholds and manufacturer maximum-life rules, not an arbitrary universal health score. Do not claim a dedicated UF prediction from the available sensors.",
    blueprint: "Persist prediction snapshots so trend, alert, acknowledgement, and eventual replacement can be audited against the same evidence window.",
    visual: "health",
  },
  {
    title: "The household sees what to do next.",
    kicker: "11 · CUSTOMER EXPERIENCE",
    zone: "action",
    lead: "A useful prediction should explain the issue, show its uncertainty, and guide a safe next step.",
    foot: "Customer app is a browser mock driven by the same simulation state.",
    tags: ["Plain-language alert", "Filter status", "Guided replacement"],
    notes: "Walk through device overview, readings, filter health, range, alert explanation, and a guided replacement action. This is a concept mockup—not a connected mobile application. Do not imply the user should bypass purifier safety behavior.",
    blueprint: "These cards can later map to app endpoints and event-driven notifications. Preserve a clear split between predictive advisory and mandatory purifier lockout.",
    visual: "customer",
  },
  {
    title: "A service request is a separate workflow.",
    kicker: "12 · SERVICE OPERATIONS",
    zone: "action",
    lead: "Prediction creates a recommendation; stock, approval, serviceability, dispatch, and delivery happen separately.",
    foot: "Pincode intelligence and pincode logistics are not the same capability.",
    tags: ["Demo SKU", "Synthetic inventory", "Simulated delivery"],
    notes: "Pincode-based fleet priors are a predictive personalization concept. Delivery serviceability is a distinct proposed business workflow for this demo. Show the request's lifecycle and the source of each operational status.",
    blueprint: "Future workflow entities: replacement request, inventory reservation, serviceability decision, assignment, dispatch tracking, and replacement completion—with IDs and timestamps.",
    visual: "service",
  },
  {
    title: "Change the condition. Trace the consequence.",
    kicker: "13 · SCENARIO LAB",
    zone: "edge",
    lead: "Inject a fault or switch the source, then follow the same signals through the full product story.",
    foot: "Sensor malfunction lowers confidence; it is not automatically treated as a filter failure.",
    tags: ["Deterministic scenarios", "Correlated signals", "Safety remains separate"],
    notes: "Use controls to change the shared scenario. Source profiles and fault dynamics are deliberately synthetic demo settings. The sensor-fault option suppresses reliable model interpretation and demonstrates counter-based fallback behavior.",
    blueprint: "This scenario configuration becomes a reproducible test fixture for future simulator, ingestion, model, and end-to-end acceptance tests.",
    visual: "scenarios",
  },
  {
    title: "From a changed drop to a better-timed visit.",
    kicker: "14 · THE COMPLETE JOURNEY",
    zone: "action",
    lead: "AquaTwin connects purifier behavior to a clear explanation and a coordinated next action.",
    foot: "Replay the complete product walkthrough—or step through the pipeline at your own pace.",
    tags: ["Observe", "Estimate", "Explain", "Coordinate"],
    notes: "Close with the whole chain: water changes, device observes, edge filters, cloud estimates, application explains, service workflow coordinates. Project performance and hardware-cost metrics from the abstract are targets for later rig validation, not demonstrated results.",
    blueprint: "The browser walkthrough is also a product blueprint: each stage carries its intended responsibilities, signals, interfaces, assumptions, and future validation work.",
    visual: "end",
  },
];

const state = {
  scene: 0,
  source: "municipal",
  fault: "healthy",
  selectedPart: "ro",
  selectedSensor: "input-tds",
  motionPaused: false,
  simRunning: false,
  simSpeed: 5,
  simDay: 0,
  serviceStep: 0,
  npf: { qp: "", ndpRef: "", ndp: "" },
  scriptIndex: -1,
  scriptTimer: null,
};

const SERVICE_STEPS = ["Recommended", "Approved", "Stock reserved", "Serviceable", "Dispatched", "Delivered", "Replaced"];
let toastTimer = null;
let simulationTimer = null;
let renderKey = 0;
let chartCounter = 0;

function predictionRangeFor(sourceId = state.source, fault = state.fault, day = state.simDay) {
  if (fault === "sensor-malfunction" || fault === "ro-bypass") return null;
  if (fault === "ro-fouling") return [30, 38, 47].map((value) => Math.max(0, value - day));
  const sourceRanges = {
    municipal: [120, 160, 210],
    tanker: [70, 100, 135],
    borewell: [48, 76, 110],
  };
  return sourceRanges[sourceId] || sourceRanges.municipal;
}

function getMetrics() {
  const source = SOURCE_PROFILES[state.source];
  const fault = state.fault;
  const foulingLevel = fault === "ro-fouling" ? clamp(0.22 + state.simDay * 0.035, 0.22, 0.62) : 0;
  const sedimentLevel = fault === "sediment-clog" ? clamp(0.28 + state.simDay * 0.045, 0.28, 0.76) : 0;
  const pumpWear = fault === "pump-wear" ? clamp(0.18 + state.simDay * 0.025, 0.18, 0.55) : 0;
  const uvAge = fault === "uv-ageing" ? clamp(0.55 + state.simDay * 0.012, 0.55, 0.82) : 0;
  const carbonUse = fault === "carbon-exhaustion" ? clamp(0.86 + state.simDay * 0.01, 0.86, 1) : 0;

  const inputTds = fault === "sensor-malfunction" ? 298 : source.feedTds;
  const trueSaltPassage = clamp(35 / 650 + foulingLevel * 0.09 + (fault === "ro-bypass" ? 0.145 : 0), 0.015, 0.3);
  const outputTds = fault === "sensor-malfunction" ? 999 : Math.round(inputTds * trueSaltPassage);
  const saltPassage = fault === "sensor-malfunction" ? null : outputTds / Math.max(1, inputTds);
  const tcf = Math.exp(2640 * (1 / 298 - 1 / (273 + source.temperature)));
  const flowLoss = clamp(foulingLevel * 0.47 + sedimentLevel * 0.5, 0, 0.68);
  const permeateFlow = 0.25 * (1 - flowLoss);
  const fillTime = 32 / Math.max(0.32, 1 - flowLoss);
  const inletPressure = fault === "sediment-clog" ? 0.18 - sedimentLevel * 0.07 : 0.18;
  const pumpCurrent = Math.round(520 + pumpWear * 390);
  const uvCurrent = Math.round(310 * (1 - uvAge * 0.58));
  const pumpRuntimeSec = 240 + Math.min(120, state.simDay * 4);
  const steady = state.simDay > 0 || state.scene > 0;
  const sensorValid = fault !== "sensor-malfunction";

  const health = {
    sediment: fault === "sediment-clog" ? Math.round((1 - sedimentLevel) * 100) : 96,
    carbon: fault === "carbon-exhaustion" ? Math.round((1 - carbonUse) * 100) : 91,
    ro: fault === "ro-fouling" ? Math.round((1 - foulingLevel * 0.78) * 100) : fault === "ro-bypass" ? 36 : 94,
    uf: 92,
    uv: fault === "uv-ageing" ? Math.round((1 - uvAge * 0.72) * 100) : 93,
  };
  const rul = {
    sediment: fault === "sediment-clog" ? Math.max(4, 20 - state.simDay) : 138,
    carbon: fault === "carbon-exhaustion" ? Math.max(2, 12 - state.simDay) : 96,
    ro: predictionRangeFor(state.source, fault, state.simDay)?.[1] ?? null,
    uf: 120,
    uv: fault === "uv-ageing" ? Math.max(7, 48 - state.simDay * 2) : 210,
  };

  const npfInputs = {
    qp: Number(state.npf.qp),
    ndpRef: Number(state.npf.ndpRef),
    ndp: Number(state.npf.ndp),
  };
  const npfReady = sensorValid && [npfInputs.qp, npfInputs.ndpRef, npfInputs.ndp].every((n) => Number.isFinite(n) && n > 0);
  const npf = npfReady ? npfInputs.qp * (npfInputs.ndpRef / npfInputs.ndp) / tcf : null;

  return {
    source, inputTds, outputTds, temperature: source.temperature, tcf, saltPassage, trueSaltPassage,
    permeateFlow, fillTime, inletPressure, pumpCurrent, uvCurrent, foulingLevel, sedimentLevel,
    pumpWear, uvAge, carbonUse, pumpRuntimeSec, health, rul, sensorValid, steady, npf, npfReady,
    status: fault === "sensor-malfunction" ? "DEGRADED DATA" : fault === "ro-bypass" ? "QUALITY ALERT" :
      fault === "healthy" ? "NOMINAL" : "ATTENTION",
    confidence: fault === "sensor-malfunction" ? "LOW" : fault === "healthy" ? "HIGH" : "DEMO",
  };
}

function formatPassage(metrics = getMetrics()) {
  return metrics.saltPassage == null ? "—" : `${(metrics.saltPassage * 100).toFixed(2)}%`;
}

function stageStatus(stage, metrics = getMetrics()) {
  if (state.fault === "sensor-malfunction") return { label: "Sensor confidence low", value: null };
  const health = metrics.health[stage];
  if (stage === "ro" && state.fault === "ro-bypass") return { label: "Quality alert", value: health };
  if (stage === "ro" && state.fault === "ro-fouling") return { label: "Degrading · trend injected", value: health };
  if (stage === "sediment" && state.fault === "sediment-clog") return { label: health <= 35 ? "Replace / inspect" : "Degrading · restriction", value: health };
  if (health <= 35) return { label: "Replace / inspect", value: health };
  if (health <= 72) return { label: "Degrading", value: health };
  return { label: "Healthy", value: health };
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2300);
}

function syncUrl() {
  try {
    const url = new URL(location.href);
    url.searchParams.set("source", state.source);
    url.searchParams.set("fault", state.fault);
    url.hash = `scene-${pad2(state.scene + 1)}`;
    history.replaceState(null, "", url);
  } catch {
    // Local file mode may not permit query/history updates; scene controls still work.
    location.hash = `scene-${pad2(state.scene + 1)}`;
  }
}

function safeText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function svgIcon(name) {
  const paths = {
    water: '<path d="M12 2.5C9.5 6.7 5.5 10.7 5.5 15a6.5 6.5 0 0 0 13 0c0-4.3-4-8.3-6.5-12.5Z"/><path d="M9 15.8c.4 1.5 1.5 2.4 3.2 2.6"/>',
    cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/>',
    broker: '<circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/><path d="m7 7.5 3 2.8m7-2.8-3 2.8m-7 6.2 3-2.8m7 2.8-3-2.8"/>',
    cloud: '<path d="M7 18.5h10a4 4 0 0 0 .4-8A5.7 5.7 0 0 0 6.5 9 4.8 4.8 0 0 0 7 18.5Z"/><path d="M9 14h6m-5-2 2-2 2 2"/>',
    chart: '<path d="M4 19V5m0 14h17"/><path d="m7 15 3-4 3 2 5-6"/><circle cx="18" cy="7" r="1"/>',
    phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.2"/><path d="M10 5h4m-3 13h2"/>',
    box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.7 7.5 4.4 7.5-4.4M12 12v9"/>',
    shield: '<path d="M12 3 19 6v5c0 4.2-2.8 7.6-7 10-4.2-2.4-7-5.8-7-10V6l7-3Z"/><path d="m9 12 2 2 4-4"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.chart}</svg>`;
}

function purifierSvg({ sensors = false, selected = null, dim = false } = {}) {
  const order = [
    { id: "inlet", x: 48, type: "inlet", label: "INLET", mini: "feed" },
    { id: "sediment", x: 172, type: "filter", label: "SEDIMENT", mini: "filter 01" },
    { id: "carbon", x: 296, type: "filter", label: "CARBON", mini: "filter 02" },
    { id: "pump", x: 420, type: "pump", label: "PUMP", mini: "pressurize" },
    { id: "ro", x: 544, type: "ro", label: "RO MEMBRANE", mini: "filter 03" },
    { id: "uf", x: 668, type: "filter", label: "UF", mini: "filter 04" },
    { id: "uv", x: 792, type: "uv", label: "UV", mini: "treatment" },
    { id: "mineral", x: 916, type: "filter", label: "MINERAL", mini: "conditioning" },
    { id: "tank", x: 1040, type: "tank", label: "TANK", mini: "storage" },
  ];
  const groups = order.map((part, index) => {
    const selectedClass = selected === part.id ? "is-selected" : "";
    const dimClass = dim && selected && selected !== part.id ? "is-dim" : "";
    const faultClass = part.id === "ro" && state.fault === "ro-bypass" ? "is-critical" :
      (part.id === "ro" && state.fault === "ro-fouling") || (part.id === "sediment" && state.fault === "sediment-clog") ? "is-warning" : "";
    let symbol = "";
    if (part.type === "inlet") {
      symbol = `<path class="component-symbol" d="M${part.x - 27} 142h18m-6-5 6 5-6 5m-14-22v44m0-8h9m-9-28h9"/>`;
    } else if (part.type === "pump") {
      symbol = `<circle class="component-shell" cx="${part.x}" cy="151" r="28"/><path class="component-symbol" d="M${part.x - 10} 141l21 10-21 10z"/><path class="component-symbol" d="M${part.x - 29} 151h-5m62 0h5"/>`;
    } else if (part.type === "tank") {
      symbol = `<path class="component-shell" d="M${part.x - 25} 118q0-8 8-8h34q8 0 8 8v67q0 8-8 8h-34q-8 0-8-8z"/><path class="component-cap" d="M${part.x - 17} 110v-6h34v6"/><path class="tank-water" d="M${part.x - 23} 155h46v30q0 6-7 6h-32q-7 0-7-6z"/><path class="component-symbol" d="M${part.x - 17} 137h34m-34 7h34"/>`;
    } else if (part.type === "ro") {
      symbol = `<rect class="component-shell" x="${part.x - 30}" y="112" width="60" height="78" rx="23"/><path class="ro-membrane" d="M${part.x - 12} 119v64m8-64v64m8-64v64"/><path class="component-cap" d="M${part.x - 18} 107h36v8h-36z"/>`;
    } else if (part.type === "uv") {
      symbol = `<rect class="component-shell" x="${part.x - 24}" y="116" width="48" height="70" rx="20"/><path class="component-symbol" d="M${part.x} 124v53m-9-43 18 27m0-27-18 27"/><circle cx="${part.x}" cy="151" r="8" fill="rgba(82,223,212,.14)" stroke="#52dfd4" stroke-width="1"/>`;
    } else {
      symbol = `<rect class="component-shell" x="${part.x - 29}" y="112" width="58" height="78" rx="16"/><path class="component-cap" d="M${part.x - 19} 108h38v8h-38z"/><path class="component-symbol" d="M${part.x - 16} 130h32m-32 10h32m-32 10h32m-32 10h32"/>`;
    }
    return `<g class="component-group ${selectedClass} ${dimClass} ${faultClass}" data-part="${part.id}" tabindex="0" role="button" aria-label="Inspect ${part.label}">
      <title>${safeText(PARTS[part.id].name)} — select to inspect</title>
      ${symbol}
      <text class="component-label" x="${part.x}" y="220">${part.label}</text>
      <text class="component-mini" x="${part.x}" y="234">${part.mini}</text>
      <text class="component-code" x="${part.x}" y="250">${String(index + 1).padStart(2, "0")}</text>
    </g>`;
  }).join("");

  const sensorDefs = [
    { id: "input-tds", x: 70, y: 77, lx: 70, ly: 51, label: "TDS IN" },
    { id: "temperature", x: 116, y: 273, lx: 116, ly: 294, label: "TEMP" },
    { id: "inlet-pressure", x: 351, y: 76, lx: 351, ly: 51, label: "P IN · KIT" },
    { id: "pump-current", x: 420, y: 76, lx: 420, ly: 51, label: "I PUMP · KIT" },
    { id: "ro-pressure", x: 544, y: 76, lx: 544, ly: 51, label: "P RO · KIT" },
    { id: "reject-flow", x: 605, y: 273, lx: 605, ly: 294, label: "REJECT · KIT" },
    { id: "uv-current", x: 792, y: 76, lx: 792, ly: 51, label: "I UV · KIT" },
    { id: "output-tds", x: 990, y: 76, lx: 990, ly: 51, label: "TDS OUT" },
    { id: "fill-time", x: 1070, y: 273, lx: 1070, ly: 294, label: "FILL TIME" },
  ];
  const sensorMarks = sensors ? sensorDefs.map((sensor) => {
    const isSelected = state.selectedSensor === sensor.id ? "is-selected" : "";
    const leaderEndY = sensor.y < 150 ? 102 : 246;
    return `<g class="sensor-marker ${isSelected}" data-sensor="${sensor.id}" tabindex="0" role="button" aria-label="Inspect sensor: ${safeText(SENSORS[sensor.id].name)}">
      <path class="sensor-leader" d="M${sensor.x} ${sensor.y < 150 ? sensor.y + 6 : sensor.y - 6} L${sensor.x} ${leaderEndY}"/>
      <circle class="marker-ring" cx="${sensor.x}" cy="${sensor.y}" r="8"/><circle class="marker-core" cx="${sensor.x}" cy="${sensor.y}" r="2.3"/>
      <text x="${sensor.lx}" y="${sensor.ly}" text-anchor="middle">${sensor.label}</text>
    </g>`;
  }).join("") : "";

  return `<svg class="purifier-svg" viewBox="0 0 1100 320" role="img" aria-label="AquaTwin purifier flow diagram from inlet through filtration stages to storage tank">
    <defs>
      <linearGradient id="water-gradient" x1="0%" x2="100%"><stop offset="0%" stop-color="#2cb7b8"/><stop offset="52%" stop-color="#62f0dc"/><stop offset="100%" stop-color="#35b7c8"/></linearGradient>
    </defs>
    <path class="pipe-base" d="M12 151H1080"/>
    <path class="pipe-water" d="M12 151H1080"/>
    <path class="flow-arrow" d="m1082 151-9-5v10z"/>
    <path d="M544 190v39h68v34" fill="none" stroke="#41616d" stroke-width="2"/>
    <path d="M544 190v39h68v34" fill="none" stroke="#52dfd4" stroke-width="1" stroke-dasharray="4 5" class="reject-flow-line"/>
    <text x="612" y="278" class="component-mini" text-anchor="middle">REJECT STREAM</text>
    ${groups}
    ${sensorMarks}
  </svg>`;
}

function selectedPartCard() {
  const part = PARTS[state.selectedPart] || PARTS.ro;
  return `<div class="selection-card">
    <div><h3>${part.name} <span class="tag">${part.kind}</span></h3><p>${part.function}<br><span class="accent-text">Monitoring:</span> ${part.approach}</p>
      <p class="selection-subline"><span class="muted-label">FAILURE SIGN</span> ${part.failure}<br><span class="muted-label">MEASUREMENTS</span> ${part.measure}</p>
    </div><div class="selection-meta">SELECTED<br>${safeText(state.selectedPart.toUpperCase())}<br><span>SIM PROFILE</span></div>
  </div>`;
}

function selectedSensorCard() {
  const sensor = SENSORS[state.selectedSensor] || SENSORS["input-tds"];
  const metrics = getMetrics();
  const examples = {
    "input-tds": `${metrics.inputTds} ppm`,
    temperature: `${metrics.temperature} °C`,
    "output-tds": `${metrics.outputTds} ppm`,
    "fill-time": `${metrics.fillTime.toFixed(0)} min`,
    "inlet-pressure": state.fault === "sediment-clog" ? `${metrics.inletPressure.toFixed(2)} MPa · simulated` : "Optional kit · not fitted",
    "pump-current": state.fault === "pump-wear" ? `${metrics.pumpCurrent} mA · simulated` : "Optional kit · not fitted",
    "ro-pressure": "Optional kit · configure",
    "reject-flow": "Optional kit · configure",
    "uv-current": state.fault === "uv-ageing" ? `${metrics.uvCurrent} mA · simulated` : "Optional kit · not fitted",
    "pump-runtime": `${metrics.pumpRuntimeSec} s`,
    "valve-state": "Purifying",
    "pump-state": "ON",
    "tank-float": "Filling",
  };
  return `<div class="selection-card sensor-selection">
    <div><h3>${sensor.name} <span class="tag amber">${sensor.unit}</span></h3><p>${sensor.why}</p></div>
    <div class="selection-meta">LOCATION<br>${sensor.location}<br><span>READING · ${examples[state.selectedSensor]}</span></div>
  </div>`;
}

function renderPurifier({ sensors = false, selected = state.selectedPart, dim = false } = {}) {
  const metrics = getMetrics();
  const svg = purifierSvg({ sensors, selected, dim });
  return `<div class="visual-frame purifier-frame">
    <span class="frame-label">PHYSICAL WATER PATH</span>
    <span class="frame-label right">INLET → TREATMENT → STORAGE</span>
    ${svg}
    <div class="purifier-legend"><span><i class="legend-water"></i>Water flow</span><span><i class="legend-sensor"></i>Measurement point</span><span><i class="legend-optional"></i>Optional kit signal</span><span class="legend-state">STATE · ${metrics.status}</span></div>
  </div>`;
}

function lineChart(values, { color = "cyan", labels = ["−6d", "−4d", "−2d", "NOW"], threshold = null, area = false } = {}) {
  const fillId = `chart-fill-${++chartCounter}`;
  const w = 440, h = 146, left = 34, right = 12, top = 14, bottom = 24;
  const innerW = w - left - right, innerH = h - top - bottom;
  const min = Math.min(...values, threshold ?? Infinity) - 0.06;
  const max = Math.max(...values, threshold ?? -Infinity) + 0.06;
  const points = values.map((value, index) => {
    const x = left + (innerW * index) / Math.max(1, values.length - 1);
    const y = top + innerH * (1 - (value - min) / Math.max(0.001, max - min));
    return [x, y];
  });
  const path = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const areaPath = `${path} L${points.at(-1)[0]} ${top + innerH} L${points[0][0]} ${top + innerH} Z`;
  const grid = [0, 1, 2, 3].map((i) => {
    const y = top + (innerH * i) / 3;
    return `<path class="chart-grid" d="M${left} ${y}H${w - right}"/>`;
  }).join("");
  const xLabels = labels.map((label, index) => `<text class="chart-label" x="${left + innerW * index / Math.max(1, labels.length - 1)}" y="${h - 5}" text-anchor="middle">${label}</text>`).join("");
  const thresholdY = threshold == null ? "" : `<path d="M${left} ${top + innerH * (1 - (threshold - min) / Math.max(.001,max-min))}H${w-right}" stroke="#f3ad5b" stroke-dasharray="4 4" stroke-width="1"/><text class="chart-label" x="${w-right-2}" y="${top + innerH * (1 - (threshold - min) / Math.max(.001,max-min))-4}" text-anchor="end" fill="#f3ad5b">configured limit</text>`;
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Synthetic indicator trend">
    <defs><linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#52dfd4" stop-opacity=".18"/><stop offset="1" stop-color="#52dfd4" stop-opacity="0"/></linearGradient></defs>
    ${grid}${thresholdY}${area ? `<path class="chart-area" style="fill:url(#${fillId})" d="${areaPath}"/>` : ""}
    <path class="chart-line ${color === "blue" ? "secondary" : ""}" d="${path}"/>
    ${points.map(([x,y], i) => i === points.length - 1 ? `<circle class="chart-dot" cx="${x}" cy="${y}" r="4"/>` : "").join("")}
    ${xLabels}
  </svg>`;
}

function ekfSparkline() {
  const m = getMetrics();
  const baseline = [0.25,0.25,0.26,0.25,0.26,0.25,0.26,0.25,0.26];
  const values = state.fault === "ro-fouling" ? baseline.map((v,i)=>v + Math.min(.44,m.foulingLevel*.48)*(i/8)) :
    state.fault === "ro-bypass" ? baseline.map((v,i)=>v + (i > 6 ? .23 : 0)) : baseline;
  return lineChart(values, { labels: ["−8","−6","−4","−2","−1","−h","NOW"], area: true });
}

function seededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function particleCloudSvg() {
  const random = seededRandom(1001 + (state.source === "tanker" ? 33 : state.source === "borewell" ? 71 : 0) + (state.fault === "ro-fouling" ? 19 : 0));
  let paths = "";
  for (let i = 0; i < 500; i++) {
    const end = 44 + random() * 91;
    const wiggle = () => (random() - .5) * 8;
    const points = [
      [8, 17 + random() * 7], [53, 23 + wiggle()], [99, 32 + wiggle()],
      [146, 43 + wiggle()], [196, 53 + wiggle()], [246, 68 + wiggle()],
      [296, 82 + (end - 90) * .18 + wiggle()],
    ];
    const d = points.map(([x,y], j) => `${j ? "L" : "M"}${x} ${clamp(y + (state.fault === "healthy" ? 12 : 0), 8, 116).toFixed(1)}`).join(" ");
    paths += `<path class="particle-path ${i % 31 === 0 ? "active" : ""}" d="${d}"/>`;
  }
  return `<svg viewBox="0 0 320 126" class="chart-svg" role="img" aria-label="500 illustrative possible membrane degradation paths">
    <path class="chart-grid" d="M8 24H306M8 54H306M8 84H306M8 112H306M8 8V113M106 8V113M205 8V113M306 8V113"/>
    <path d="M8 91H306" stroke="#f3ad5b" stroke-width="1" stroke-dasharray="4 4"/>
    ${paths}
    <text x="8" y="123" class="chart-label">NOW</text><text x="282" y="123" class="chart-label">FUTURE →</text>
    <text x="207" y="17" class="chart-label" fill="#52dfd4">500 PARTICLES · ILLUSTRATIVE</text>
  </svg>`;
}

function sceneCopyMarkup(scene) {
  return `<article class="scene-copy">
    <div class="kicker">${scene.kicker}</div>
    <h1>${scene.title.replace("a calendar guess.", "<em>a calendar guess.</em>").replace("real water path.", "<em>real water path.</em>").replace("different failure story.", "<em>different failure story.</em>").replace("physical location.", "<em>physical location.</em>").replace("context.", "<em>context.</em>").replace("comparing it.", "<em>comparing it.</em>").replace("needs to travel.", "<em>needs to travel.</em>").replace("history to action.", "<em>history to action.</em>").replace("different questions.", "<em>different questions.</em>").replace("not a promise.", "<em>not a promise.</em>").replace("what to do next.", "<em>what to do next.</em>").replace("separate workflow.", "<em>separate workflow.</em>").replace("Trace the consequence.", "<em>Trace the consequence.</em>").replace("better-timed visit.", "<em>better-timed visit.</em>")}</h1>
    <p class="lead">${scene.lead}</p>
    <div class="copy-tags">${scene.tags.map((tag) => `<span class="copy-tag">${tag}</span>`).join("")}</div>
    <div class="copy-foot">${scene.foot}</div>
  </article>`;
}

function layout(scene, visual, wide = false) {
  if (wide) {
    return `<div class="scene-layout wide-layout">${sceneCopyMarkup(scene)}<div class="visual-panel wide">${visual}</div></div>`;
  }
  return `<div class="scene-layout">${sceneCopyMarkup(scene)}<div class="visual-panel">${visual}</div></div>`;
}

function problemVisual() {
  const m = getMetrics();
  const municipal = SOURCE_PROFILES.municipal.feedTds;
  const shownProfile = state.source === "municipal" ? SOURCE_PROFILES.tanker : m.source;
  const shownSource = state.source === "municipal" ? "TANKER · NEXT DEMO STEP" : state.source.toUpperCase();
  return `<div class="visual-frame problem-frame">
    <span class="frame-label">SAME DEVICE · DIFFERENT WATER HISTORY</span>
    <div class="problem-topline">
      <div class="problem-device"><span class="device-icon">${svgIcon("water")}</span><div><strong>AQT-1001</strong><small>Hyderabad household · synthetic demo</small></div></div>
      <span class="tag ${state.fault === "healthy" ? "" : "amber"}">${FAULTS[state.fault].short.toUpperCase()}</span>
    </div>
    <div class="problem-comparison">
      <div class="comparison-side">
        <div class="comparison-label"><span>FIXED COUNTER</span><b>75%</b></div>
        <div class="comparison-meter"><i style="width:75%"></i></div>
        <small>Same litres · same calendar estimate</small>
        <div class="comparison-micro">LITRES <strong>1,840</strong><span>·</span> DAYS <strong>214</strong></div>
      </div>
      <div class="comparison-divider"><span>≠</span></div>
      <div class="comparison-side actual">
        <div class="comparison-label"><span>MEASURED PERFORMANCE</span><b>${state.fault === "ro-fouling" ? 61 : state.fault === "ro-bypass" ? 31 : 93}%</b></div>
        <div class="comparison-meter"><i style="width:${state.fault === "ro-fouling" ? 61 : state.fault === "ro-bypass" ? 31 : 93}%"></i></div>
        <small>Input ${m.inputTds} ppm · source ${m.source.label.toLowerCase()}</small>
        <div class="comparison-micro">SALT PASSAGE <strong>${formatPassage(m)}</strong><span>·</span> FILL <strong>${m.fillTime.toFixed(0)} min</strong></div>
      </div>
    </div>
    <div class="problem-shift">
      <div class="shift-track"><span class="shift-dot"></span><span class="shift-event">MUNICIPAL · ${municipal} ppm</span><i></i><span class="shift-event active">${shownSource} · ${shownProfile.feedTds} ppm</span><span class="shift-marker">${state.source === "municipal" ? "POSSIBLE SOURCE CHANGE" : "CURRENT DEMO PROFILE"}</span></div>
    </div>
    <div class="problem-bottom"><span class="tiny-led"></span><span>AQUATWIN</span><b>Measure each stage’s behavior. Explain what changed.</b><span class="problem-arrow">→</span></div>
    <div class="synthetic-footnote">Illustrative source-profile values for this browser demo—not regional water measurements.</div>
  </div>`;
}

function componentVisual(scene) {
  return `<div class="component-explorer">
    ${renderPurifier({ selected: state.selectedPart, dim: true })}
    ${selectedPartCard()}
  </div>`;
}

function sensorVisual() {
  const m = getMetrics();
  const tileData = [
    ["input-tds", "INPUT TDS", `${m.inputTds} ppm`, "BASE SIGNAL · INLET"],
    ["temperature", "TEMPERATURE", `${m.temperature} °C`, "BASE SIGNAL · INLET"],
    ["output-tds", "OUTPUT TDS", `${m.outputTds} ppm`, "BASE SIGNAL · OUTPUT"],
    ["fill-time", "TANK FILL", `${m.fillTime.toFixed(0)} min`, "FLOAT-SWITCH TIMING"],
    ["inlet-pressure", "INLET PRESSURE", state.fault === "sediment-clog" ? `${m.inletPressure.toFixed(2)} MPa` : "—", "OPTIONAL KIT"],
    ["pump-current", "PUMP CURRENT", state.fault === "pump-wear" ? `${m.pumpCurrent} mA` : "—", "OPTIONAL KIT"],
    ["ro-pressure", "RO PRESSURE", "—", "OPTIONAL KIT"],
    ["uv-current", "UV CURRENT", state.fault === "uv-ageing" ? `${m.uvCurrent} mA` : "—", "OPTIONAL KIT"],
    ["pump-runtime", "PUMP RUNTIME", `${m.pumpRuntimeSec} s`, "CONTROLLER SIGNAL"],
    ["valve-state", "VALVE STATE", "PURIFYING", "CONTROLLER SIGNAL"],
    ["pump-state", "PUMP STATE", "ON", "CONTROLLER SIGNAL"],
    ["tank-float", "TANK FLOAT", "FILLING", "FLOAT-SWITCH STATE"],
  ];
  return `<div class="sensor-explorer">
    ${renderPurifier({ sensors: true, selected: null })}
    ${selectedSensorCard()}
    <div class="measurement-grid">${tileData.map(([id,name,value,kind]) => `<button class="measurement-tile ${state.selectedSensor === id ? "is-selected" : ""}" data-sensor="${id}">
      <small>${name}</small><strong>${value}</strong><span>${kind}</span>
    </button>`).join("")}</div>
  </div>`;
}

function edgeVisual() {
  const m = getMetrics();
  return `<div class="edge-stack">
    <div class="visual-frame edge-flow-frame">
      <span class="frame-label">LOCAL EDGE PATH · SIMULATED</span>
      <div class="edge-inputs">
        <div class="edge-sensor-capsule"><span>INPUT TDS</span><b>${m.inputTds}<small>ppm</small></b></div>
        <div class="edge-sensor-capsule"><span>OUTPUT TDS</span><b>${m.outputTds}<small>ppm</small></b></div>
        <div class="edge-sensor-capsule"><span>TEMP</span><b>${m.temperature}<small>°C</small></b></div>
        <div class="edge-sensor-capsule optional"><span>PRESSURE / CURRENT</span><b>OPTIONAL</b></div>
      </div>
      <div class="edge-bus"><span class="edge-packet"></span><span class="edge-packet delay"></span><i></i><b>1 Hz while pump runs</b><i></i></div>
      <div class="chip-visual">
        <div class="chip-callout left">Validate ranges</div><div class="chip-callout right">Steady-state gate</div>
        <div class="chip-board"><div class="chip-pin left">${Array.from({length:6},()=>"<i></i>").join("")}</div><div class="chip-pin right">${Array.from({length:6},()=>"<i></i>").join("")}</div>
          <div class="chip-core"><strong>ESP32-S3</strong><span>EDGE SIMULATOR</span></div>
        </div>
        <div class="chip-callout bottom">Temperature correction · EKF</div>
      </div>
      <div class="edge-output"><span>LOCAL STATE</span><b>${m.status}</b><i></i><span>TELEMETRY SUMMARY → MQTT</span></div>
    </div>
    <div class="metric-row edge-metrics">
      <div class="metric-card"><small>READ QUALITY</small><strong class="${m.sensorValid ? "" : "text-red"}">${m.sensorValid ? "VALID" : "SUSPECT"}</strong><em>${m.sensorValid ? "steady-state eligible" : "fallback counter path"}</em></div>
      <div class="metric-card"><small>STEADY STATE</small><strong>${m.steady ? ">60 s" : "WAIT"}</strong><em>pump + stable flow gate</em></div>
      <div class="metric-card"><small>CLOUD PAYLOAD</small><strong>SUMMARY</strong><em>not every raw sample</em></div>
    </div>
  </div>`;
}

function formulaVisual() {
  const m = getMetrics();
  const npfResult = m.npfReady ? `${m.npf.toFixed(3)} · configured demo inputs` : "Awaiting Qp, NDPref and NDP";
  return `<div class="formula-workbench">
    <div class="visual-frame formula-frame">
      <span class="frame-label">EDGE INDICATORS · LIVE FROM SHARED STATE</span>
      <div class="formula-flow">
        <div class="formula-input-readings">
          <span><small>INPUT TDS</small><b>${m.inputTds}<i>ppm</i></b></span>
          <span><small>OUTPUT TDS</small><b>${m.outputTds}<i>ppm</i></b></span>
          <span><small>WATER TEMP</small><b>${m.temperature}<i>°C</i></b></span>
        </div>
        <div class="formula-arrow">↓</div>
        <div class="formula-stack">
          <div class="formula-card">
            <div class="formula-name">01 · TEMPERATURE CORRECTION FACTOR</div>
            <div class="formula-equation">TCF = exp[2640 × (1/298 − 1/(273 + T))]</div>
            <div class="formula-result">T = ${m.temperature}°C → TCF = ${m.tcf.toFixed(3)} <span class="result-caption">reference: 25°C</span></div>
            <button class="small-action formula-example-button" data-action="use-formula-example">Load brief example · 650 / 35 / 28°C</button>
          </div>
          <div class="formula-card">
            <div class="formula-name">02 · SALT PASSAGE</div>
            <div class="formula-equation">TDSout / TDSin = ${m.outputTds} / ${m.inputTds}</div>
            <div class="formula-result">${m.sensorValid ? `→ ${(m.saltPassage * 100).toFixed(2)}%` : "→ not computed · sensor quality fault"}</div>
          </div>
          <div class="formula-card npf-card">
            <div class="formula-name">03 · NORMALIZED PERMEATE FLOW</div>
            <div class="formula-equation">NPF = Qp × (NDPref / NDP) / TCF</div>
            <div class="formula-inputs">
              <label>Qp · L/min<input type="number" min="0" step="0.01" data-npf="qp" value="${safeText(state.npf.qp)}" placeholder="configure"></label>
              <label>NDPref · MPa<input type="number" min="0" step="0.01" data-npf="ndpRef" value="${safeText(state.npf.ndpRef)}" placeholder="configure"></label>
              <label>NDP · MPa<input type="number" min="0" step="0.01" data-npf="ndp" value="${safeText(state.npf.ndp)}" placeholder="configure"></label>
            </div>
            <div class="formula-result" id="npf-result">${npfResult}</div>
          </div>
        </div>
      </div>
      <div class="ekf-strip">
        <div class="ekf-heading"><span class="tag">EXTENDED KALMAN FILTER</span><small>hidden state estimate · illustrative</small></div>
        <div class="ekf-states"><span><i>01</i> Fouling resistance <b>${state.fault === "ro-fouling" ? "↑" : "—"}</b></span><span><i>02</i> Fouling growth rate <b>${state.fault === "ro-fouling" ? "↑" : "—"}</b></span><span><i>03</i> TDS sensor offset <b>${state.fault === "sensor-malfunction" ? "!" : "≈"}</b></span></div>
      </div>
    </div>
    <div class="formula-caveat">NPF is intentionally not assigned a result until all configured flow and NDP inputs are provided. Pressure/osmotic calibration is not specified by the abstract.</div>
  </div>`;
}

function mqttVisual() {
  const m = getMetrics();
  return `<div class="mqtt-stack">
    <div class="visual-frame mqtt-frame">
      <span class="frame-label">MESSAGE PATH · CONCEPTUAL PROTOCOL WALKTHROUGH</span>
      <div class="mqtt-route">
        <div class="mqtt-endpoint edge-end">${svgIcon("cpu")}<b>EDGE DEVICE</b><small>AQT-1001</small></div>
        <div class="mqtt-lane"><span class="topic-label">aquatwin/v1/devices/AQT-1001/telemetry</span><div class="message-lane"><i class="message-packet"></i><i class="message-packet delay"></i><i class="message-packet delay-two"></i></div><span class="lane-caption">versioned summary · QoS 1 concept</span></div>
        <div class="mqtt-broker"><div class="broker-rings"></div>${svgIcon("broker")}<b>MQTT</b><small>BROKER</small></div>
        <div class="mqtt-lane reverse"><span class="topic-label">subscriber receives · validates · persists</span><div class="message-lane"><i class="message-packet"></i><i class="message-packet delay"></i></div><span class="lane-caption">reconnect · deduplicate · timestamp</span></div>
        <div class="mqtt-endpoint cloud-end">${svgIcon("cloud")}<b>CLOUD</b><small>BACKEND SUBSCRIBER</small></div>
      </div>
      <div class="payload-preview"><div class="payload-head"><span class="tiny-led"></span><b>TELEMETRY SUMMARY</b><span class="payload-version">edge-telemetry.v1</span></div>
        <code>{ "schema_version": "edge-telemetry.v1", "device_id": "AQT-1001",<br>
          &nbsp; "timestamp": "UTC ISO-8601", "sequence": 18420,<br>
          &nbsp; "input_tds_ppm": ${m.inputTds}, "output_tds_ppm": ${m.outputTds},<br>
          &nbsp; "pump_runtime_s": ${m.pumpRuntimeSec}, "tank_fill_time_min": ${m.fillTime.toFixed(0)},<br>
          &nbsp; "salt_passage": ${m.saltPassage == null ? "null" : m.saltPassage.toFixed(4)}, "edge_status": "${m.status.toLowerCase()}" }</code>
      </div>
      <div class="mqtt-foot"><span>Broker distributes</span><b>≠</b><span>Backend analyzes</span><i></i><span>Raw 1 Hz readings stay local by default</span></div>
    </div>
  </div>`;
}

function cloudVisual() {
  return `<div class="cloud-workbench">
    <div class="visual-frame cloud-frame">
      <span class="frame-label">MODULAR CLOUD RESPONSIBILITIES</span>
      <div class="cloud-layers">
        <div class="cloud-layer"><span class="layer-index">01 / INGEST</span>${svgIcon("broker")}<strong>FastAPI + MQTT subscriber</strong><small>Validate schema · identify device · persist message</small><span class="layer-arrow">›</span></div>
        <div class="cloud-layer"><span class="layer-index">02 / HISTORY</span>${svgIcon("box")}<strong>TimescaleDB concept</strong><small>Telemetry hypertable + device and workflow records</small><span class="layer-arrow">›</span></div>
        <div class="cloud-layer"><span class="layer-index">03 / ANALYTICS</span>${svgIcon("chart")}<strong>Analytics worker</strong><small>Health · uncertainty · causes · source shifts</small><span class="layer-arrow">›</span></div>
        <div class="cloud-layer"><span class="layer-index">04 / SERVE</span>${svgIcon("phone")}<strong>Application APIs</strong><small>REST / updates · alerts · service request state</small></div>
      </div>
      <div class="cloud-lanes">
        <div class="cloud-lane"><span>DEVICE INGEST</span><i></i><b>Versioned telemetry</b></div>
        <div class="cloud-lane"><span>MODEL OUTPUT</span><i></i><b>Prediction + evidence</b></div>
        <div class="cloud-lane service-lane"><span>PROPOSED EXTENSION</span><i></i><b>Inventory / dispatch workflow</b></div>
      </div>
      <div class="cloud-boundary"><span>MODEL PERSONALIZATION</span><b>Pincode priors ≠ delivery serviceability</b><span>Separate data + separate decision</span></div>
    </div>
    <div class="synthetic-footnote">Architecture visualization only · no backend service is contacted by this local presentation.</div>
  </div>`;
}

function algorithmVisual() {
  const m = getMetrics();
  const currentRange = predictionRangeFor();
  const ekf = `<article class="algorithm-card"><div class="algorithm-top"><div><h3>Extended Kalman Filter</h3><span class="algorithm-location">EDGE · HIDDEN-STATE ESTIMATE</span></div><span class="tag">3 STATES</span></div>
    <div class="algorithm-visual">${ekfSparkline()}</div><p>Fouling resistance · growth rate · TDS offset</p></article>`;
  const rangeMarkup = currentRange
    ? `<div class="particle-range"><span>P10 <b>${currentRange[0]}d</b></span><span>P50 <b>${currentRange[1]}d</b></span><span>P90 <b>${currentRange[2]}d</b></span></div>`
    : `<div class="particle-unavailable">${state.fault === "ro-bypass" ? "Immediate inspection · RUL not applicable" : "Forecast held · sensor confidence low"}</div>`;
  const particle = `<article class="algorithm-card"><div class="algorithm-top"><div><h3>Particle Filter · ~500 paths</h3><span class="algorithm-location">CLOUD · REMAINING LIFE</span></div><span class="tag amber">SYNTHETIC</span></div>
    <div class="algorithm-visual">${particleCloudSvg()}</div>${rangeMarkup}<div class="particle-example">REFERENCE FOULING RUN · P10 30d / P50 38d / P90 47d</div></article>`;
  const classes = [
    ["Sediment clog","sediment-clog"],["RO fouling","ro-fouling"],["RO bypass","ro-bypass"],
    ["Pump wear","pump-wear"],["UV ageing","uv-ageing"],["Carbon exhaust.","carbon-exhaustion"],
  ];
  const isTop = state.fault === "healthy" ? null : state.fault;
  const demoConfidence = {
    "sediment-clog": "0.88", "ro-fouling": "0.86", "ro-bypass": "0.93",
    "pump-wear": "0.81", "uv-ageing": "0.84", "carbon-exhaustion": "0.76",
  };
  const classifierOutput = isTop
    ? `<small>TOP DEMO HYPOTHESIS</small><strong>${FAULTS[isTop]?.short || "Review data"}</strong><span>demo probability ${demoConfidence[isTop] || "—"} · not calibrated</span>`
    : `<small>CLASSIFIER OUTPUT</small><strong>NO FAULT INJECTED</strong><span>baseline synthetic pattern</span>`;
  const classifier = `<article class="algorithm-card"><div class="algorithm-top"><div><h3>Gradient boosting</h3><span class="algorithm-location">CLOUD · LIKELY CAUSE</span></div><span class="tag amber">SYNTHETIC MODEL</span></div>
    <div class="classifier-flow"><div class="feature-stack"><i>NPF ↓</i><i>SALT ↑</i><i>FILL Δ</i><i>QUALITY</i></div><span class="classifier-arrow">→</span><div class="tree-stack"><b>tree 01</b><b>tree 02</b><b>tree 03</b></div><span class="classifier-arrow">→</span><div class="class-result">${classifierOutput}</div></div>
    <div class="fault-classes">${classes.map(([label,id])=>`<span class="fault-class ${id === isTop ? "is-top" : ""}">${label}</span>`).join("")}</div></article>`;
  const trendVals = state.source === "tanker" ? [0.28,0.29,0.30,0.31,0.47,0.62,0.66,0.65,0.69] :
    state.source === "borewell" ? [0.29,0.28,0.3,0.29,0.61,0.72,0.75,0.77,0.76] : [0.25,0.27,0.24,0.26,0.25,0.27,0.24,0.25,0.26];
  const sourceChart = lineChart(trendVals, { color: "blue", labels: ["−8","−7","−6","−5","−4","−3","−2","−1","NOW"] });
  const changePoint = `<article class="algorithm-card"><div class="algorithm-top"><div><h3>Bayesian change point</h3><span class="algorithm-location">CLOUD · INPUT DISTRIBUTION</span></div><span class="tag ${state.source === "municipal" ? "" : "amber"}">${state.source === "municipal" ? "STABLE" : "POSSIBLE SHIFT"}</span></div>
    <div class="algorithm-visual change-visual">${sourceChart}${state.source === "municipal" ? "" : '<span class="change-label">possible change</span>'}</div><p>Feed TDS level + variability + temperature → possible source-profile change; not source proof.</p></article>`;
  return `<div class="algorithm-grid">${ekf}${particle}${classifier}${changePoint}</div>
    <div class="algorithm-disclaimer">Illustrative visualizations over deterministic synthetic scenario state · not field validation.</div>`;
}

function healthRow(label, stage, metrics, { estimated = false, notModeled = false } = {}) {
  if (notModeled) {
    return `<div class="health-row not-modeled"><div><div class="health-name">${label}</div><div class="health-state">No dedicated model</div></div>
      <div class="health-meter unavailable"><i style="width:0%"></i></div><div class="health-percent">—</div><div class="health-rul"><small>RUL</small>Not set</div></div>`;
  }
  const status = stageStatus(stage, metrics);
  const value = metrics.sensorValid ? (status.value ?? metrics.health[stage]) : null;
  const className = value == null ? "" : value <= 35 ? "critical" : value <= 72 ? "warning" : "";
  const rul = metrics.rul[stage];
  return `<div class="health-row">
    <div><div class="health-name">${label}</div><div class="health-state">${status.label}${estimated ? " · estimate" : ""}</div></div>
    <div class="health-meter ${value == null ? "unavailable" : ""}"><i class="${className}" style="width:${value ?? 0}%"></i></div>
    <div class="health-percent">${value == null ? "—" : `${value}%`}</div>
    <div class="health-rul"><small>ILLUSTRATIVE RUL</small>${state.fault === "sensor-malfunction" ? "—" : rul == null ? (state.fault === "ro-bypass" && stage === "ro" ? "Inspect" : "—") : `${rul} d`}</div>
  </div>`;
}

function healthVisual() {
  const m = getMetrics();
  const rangeEmphasis = state.fault === "ro-fouling" || state.fault === "healthy" ? "Illustrative particle-filter range" : "Forecast confidence reduced for injected fault";
  const range = predictionRangeFor();
  return `<div class="health-workbench">
    <div class="visual-frame health-frame">
      <span class="frame-label">DEVICE AQT-1001 · FILTER HEALTH SNAPSHOT</span>
      <span class="frame-label right"><span class="live-dot inline"></span> ${m.status}</span>
      <div class="health-summary"><div><small>INFERRED SOURCE PROFILE</small><strong>${m.source.profile}</strong></div><div><small>SENSOR QUALITY</small><strong class="${m.sensorValid ? "" : "text-red"}">${m.confidence}</strong></div><div><small>MODEL LABEL</small><strong>SYNTHETIC DEMO</strong></div></div>
      <div class="health-list">
        ${healthRow("Sediment", "sediment", m)}
        ${healthRow("Carbon", "carbon", m, { estimated: true })}
        ${healthRow("RO membrane", "ro", m)}
        ${healthRow("UF", "uf", m, { notModeled: true })}
        ${healthRow("UV", "uv", m, { estimated: true })}
      </div>
      <div class="pump-health"><span>PUMP COMPONENT · NOT A FILTER</span><b>${state.fault === "pump-wear" ? "WEAR PATTERN INJECTED" : "NO PUMP FAULT INJECTED"}</b><small>Optional current / pressure sensing improves diagnosis.</small></div>
      <div class="range-band">
        <span class="range-title">${range ? rangeEmphasis.toUpperCase() : "NO REMAINING-LIFE FORECAST · INSPECT / RESTORE SENSOR QUALITY"}</span>
        ${range ? `<div class="range-axis"></div><div class="range-fill"></div>
          <i class="range-marker p10"></i><i class="range-marker p50"></i><i class="range-marker p90"></i>
          <span class="range-caption p10">P10 · ${range[0]}d</span><span class="range-caption p50">P50 · ${range[1]}d</span><span class="range-caption p90">P90 · ${range[2]}d</span>` : `<span class="forecast-unavailable">${state.fault === "sensor-malfunction" ? "Sensor readings are suspect; fall back to existing counter." : "Possible bypass is an immediate inspection alert, not an ageing forecast."}</span>`}
      </div>
      <div class="health-safety"><span>${svgIcon("shield")}</span><div><b>ADVISORY ONLY</b><small>Existing TDS / UV / leak / dry-run interlocks remain independent and cannot be overridden.</small></div></div>
    </div>
    <div class="synthetic-footnote">Life values are illustrative demo outputs; configured thresholds and real-rig validation are future work.</div>
  </div>`;
}

function customerVisual() {
  const m = getMetrics();
  const range = predictionRangeFor();
  const roStatus = stageStatus("ro", m);
  const message = state.fault === "sensor-malfunction"
    ? "A sensor reading needs attention. Using fallback monitoring."
    : state.fault === "ro-bypass"
      ? "Sudden water-quality change. Please stop and contact service."
      : state.fault === "ro-fouling"
        ? "Membrane performance is trending down."
        : "All monitored signals are within this demo baseline.";
  const rows = [
    ["Sediment", stageStatus("sediment",m).value, "128d"],
    ["Carbon", stageStatus("carbon",m).value, "96d"],
    ["RO membrane", roStatus.value, state.fault === "ro-bypass" ? "Inspect now" : range ? `${range[0]}–${range[2]}d` : "Fallback"],
    ["UF", null, "Not forecast"],
    ["UV", stageStatus("uv",m).value, "210d"],
  ];
  return `<div class="customer-layout">
    <div class="device-mockup"><div class="device-screen"><div class="device-notch"></div>
      <div class="phone-header"><div>AquaTwin<small>GOOD MORNING · AQT-1001</small></div><span class="tiny-led"></span></div>
      <div class="phone-status ${state.fault === "ro-bypass" ? "alert" : ""}"><div class="phone-status-head"><span class="status-orb">${state.fault === "ro-bypass" ? "!" : "✓"}</span><strong>${state.fault === "sensor-malfunction" ? "Monitoring limited" : state.fault === "ro-bypass" ? "Water quality alert" : state.fault === "ro-fouling" ? "Membrane needs attention soon" : "Purifier is operating"}</strong></div><span>${message}</span></div>
      <div class="phone-section-label">FILTER HEALTH <small>DEMO ESTIMATES</small></div>
      ${rows.map(([name,value,rul])=>`<div class="phone-filter"><div><b>${name}</b><span>${!m.sensorValid ? "Sensor confidence low" : value == null ? "No dedicated model" : value <= 35 ? "Needs attention" : value <= 72 ? "Degrading" : "Healthy"}</span></div><strong>${!m.sensorValid ? "Fallback" : rul}</strong><div class="health-meter ${!m.sensorValid || value == null ? "unavailable" : ""}"><i class="${value != null && value <= 35 ? "critical" : value != null && value <= 72 ? "warning" : ""}" style="width:${m.sensorValid ? value ?? 0 : 0}%"></i></div></div>`).join("")}
      <div class="phone-reading"><span>INPUT TDS <b>${m.inputTds} ppm</b></span><span>OUTPUT TDS <b>${m.outputTds} ppm</b></span><span>TEMP <b>${m.temperature}°C</b></span></div>
      <div class="phone-cta">${state.fault === "ro-bypass" ? "CONTACT SERVICE TEAM" : state.fault === "healthy" ? "VIEW WATER QUALITY" : "REVIEW REPLACEMENT OPTIONS"}</div>
      <div class="phone-tabs"><span class="is-on">HOME</span><span>DEVICE</span><span>HELP</span></div>
    </div></div>
    <div class="customer-side">
      <div class="subpanel"><div class="subpanel-title"><strong>WHAT THE HOUSEHOLD GETS</strong><span>ONE CLEAR NEXT STEP</span></div>
        <div class="app-benefit"><i>01</i><div><b>Status by stage</b><small>Not one generic “filter life” meter.</small></div></div>
        <div class="app-benefit"><i>02</i><div><b>Reason + evidence</b><small>${state.fault === "healthy" ? "No degradation pattern injected." : FAULTS[state.fault].detail}</small></div></div>
        <div class="app-benefit"><i>03</i><div><b>Uncertainty shown honestly</b><small>Illustrative range, not a guaranteed failure date.</small></div></div>
      </div>
      <div class="app-flow"><span>TELEMETRY</span><i></i><span>ESTIMATE</span><i></i><span>GUIDED ACTION</span></div>
      <div class="synthetic-footnote">Interactive app mock · values follow the shared browser simulation.</div>
    </div>
  </div>`;
}

function serviceVisual() {
  const activeFault = state.fault !== "healthy" && state.fault !== "sensor-malfunction";
  const reqStatus = activeFault ? SERVICE_STEPS[Math.min(state.serviceStep, SERVICE_STEPS.length - 1)] : "No request";
  const sku = state.fault === "sediment-clog" ? "AQT-SED-01" :
    state.fault === "carbon-exhaustion" ? "AQT-CARB-01" :
      state.fault === "uv-ageing" ? "AQT-UV-01" : "AQT-RO-01";
  const dispatchId = state.serviceStep >= 4 ? "DSP-26041" : "—";
  const inventory = state.serviceStep >= 2 ? "Reserved · 2 units" : "In stock · 3 units";
  const serviceability = state.serviceStep >= 3 ? "Confirmed" : "Check required";
  const step = Math.min(state.serviceStep, SERVICE_STEPS.length - 1);
  const stepper = SERVICE_STEPS.map((label, index) => `<div class="workflow-step ${index < step ? "is-done" : ""} ${index === step && activeFault ? "is-current" : ""}"><i></i><span>${label}</span></div>`).join("");
  return `<div class="service-workbench">
    <div class="service-board">
      <div class="service-board-head"><div><span class="eyebrow">SERVICE OPERATIONS · PROPOSED DEMO EXTENSION</span><h3>Replacement coordination</h3></div><span class="tag ${activeFault ? "amber" : ""}">${reqStatus.toUpperCase()}</span></div>
      <div class="service-kpis"><div><small>REGISTERED DEVICES</small><b>1,284</b><span>synthetic fleet</span></div><div><small>NEED ATTENTION</small><b class="amber-text">${activeFault ? "07" : "03"}</b><span>simulated queue</span></div><div><small>OPEN REQUEST</small><b>${activeFault ? "01" : "00"}</b><span>AQT-1001</span></div></div>
      <div class="table-wrap"><table class="service-table"><thead><tr><th>DEVICE / AREA</th><th>REASON</th><th>SKU</th><th>STOCK</th><th>PIN SERVICE</th></tr></thead>
        <tbody><tr><td>AQT-1001<br><span class="muted-table">PIN 500081 · Hyderabad*</span></td><td>${activeFault ? FAULTS[state.fault].short : "No open alert"}</td><td>${activeFault ? sku : "—"}</td><td>${activeFault ? inventory : "—"}</td><td>${activeFault ? serviceability : "—"}</td></tr></tbody>
      </table></div>
      <div class="workflow-steps">${stepper}</div>
      <div class="dispatch-footer"><span>DISPATCH REF <b>${dispatchId}</b></span><span>DELIVERY <b>${state.serviceStep >= 5 ? "Out for delivery · demo" : "Not created"}</b></span></div>
      <div class="workflow-controls">
        <button class="small-action" data-action="advance-service" ${!activeFault || state.serviceStep >= SERVICE_STEPS.length - 1 ? "disabled" : ""}>Advance simulated workflow →</button>
        <span class="workflow-note">${activeFault ? "Each click advances one business step." : "Choose a replacement-related fault in the scenario lab to create a request."}</span>
      </div>
    </div>
    <div class="service-separation"><span class="tag">SEPARATE RESPONSIBILITIES</span><b>Pincode model priors</b><i>≠</i><b>Dispatch serviceability</b><small>*Synthetic demo record · not a live service coverage promise</small></div>
  </div>`;
}

function scenarioVisual() {
  const scenarios = [
    ["healthy","Healthy purifier","Baseline readings · no fault"],
    ["sediment-clog","Sediment clog","Fill time / inlet pressure pattern"],
    ["ro-fouling","RO scaling / fouling","Gradual normalized-flow decline"],
    ["ro-bypass","RO bypass / O-ring","Sudden salt-passage rise"],
    ["pump-wear","Pump wear","Current rises for similar load"],
    ["uv-ageing","UV lamp ageing","Burn-hour / current estimate"],
    ["carbon-exhaustion","Carbon exhaustion","Volume / source estimate"],
    ["sensor-malfunction","Sensor malfunction","Quality fault · counter fallback"],
  ];
  const m = getMetrics();
  const faultName = FAULTS[state.fault].label;
  return `<div class="scenario-workbench">
    <div class="visual-frame scenario-frame">
      <span class="frame-label">SCENARIO CONTROL · DETERMINISTIC DEMO PROFILES</span>
      <div class="scenario-topline"><div><small>WATER SOURCE</small><b data-live="scenario-source">${m.source.label}</b><span>Feed · <i data-live="scenario-feed">${m.inputTds}</i> ppm*</span></div><div><small>ACTIVE CONDITION</small><b data-live="scenario-fault">${faultName}</b><span>${m.status} · ${m.confidence} confidence</span></div><div><small>SIMULATED DAY</small><b data-live="scenario-day">${state.simDay}</b><span data-live="scenario-clock">${state.simRunning ? "clock advancing" : "clock paused"}</span></div></div>
      <div class="scenario-grid">${scenarios.map(([id,title,desc])=>`<button class="scenario-button ${state.fault === id ? "is-active" : ""}" data-fault="${id}">
        <strong>${title}</strong><small>${desc}</small></button>`).join("")}</div>
      <div class="scenario-readout">
        <div class="scenario-reading"><span>OUTPUT TDS</span><b data-live="scenario-output">${m.outputTds} ppm</b></div>
        <div class="scenario-reading"><span>SALT PASSAGE</span><b data-live="scenario-passage">${formatPassage(m)}</b></div>
        <div class="scenario-reading"><span>FILL TIME</span><b data-live="scenario-fill">${m.fillTime.toFixed(0)} min</b></div>
        <div class="scenario-reading"><span>EDGE QUALITY</span><b data-live="scenario-quality" class="${m.sensorValid ? "" : "text-red"}">${m.sensorValid ? "VALID" : "SUSPECT"}</b></div>
      </div>
      <div class="scenario-controls">
        <button class="small-action primary-action" data-action="toggle-sim">${state.simRunning ? "Ⅱ Pause accelerated time" : "▶ Run accelerated time"}</button>
        <label class="speed-control">SPEED <select id="sim-speed"><option value="1" ${state.simSpeed === 1 ? "selected" : ""}>1×</option><option value="5" ${state.simSpeed === 5 ? "selected" : ""}>5×</option><option value="20" ${state.simSpeed === 20 ? "selected" : ""}>20×</option></select></label>
        <span>1 demo tick = 1 illustrative simulated day · no physical calibration implied</span>
      </div>
      <div class="safety-strip"><span>${svgIcon("shield")}</span><div><b>SAFETY IS A SEPARATE LANE</b><small>Predictive output is advisory. Existing output-TDS, UV, leak, and dry-run interlocks are not overridden.</small></div></div>
    </div>
  </div>`;
}

function endVisual() {
  const steps = [
    ["01","OBSERVE","Synthetic purifier signals"],
    ["02","PROCESS","Edge validation + indicators"],
    ["03","TRANSPORT","MQTT summary"],
    ["04","PREDICT","Health + uncertainty + cause"],
    ["05","EXPLAIN","Household next step"],
    ["06","COORDINATE","Stock → service → delivery"],
  ];
  const targets = [
    ["15%","RUL error target","30 days before EOL · sensor kit"],
    ["14d","Early-warning target","Before output TDS / flow goes out of spec"],
    ["3 cycles","Bypass alert target","Within three purification cycles"],
    ["85%","Cause-ID target","Across six fault types"],
  ];
  return `<div class="end-workbench">
    <div class="visual-frame end-frame">
      <span class="frame-label">ONE CONTINUOUS PRODUCT STORY</span>
      <div class="end-journey">${steps.map(([n,title,desc],i)=>`<div class="end-step"><span>${n}</span><i>${i < steps.length-1 ? "›" : "✓"}</i><b>${title}</b><small>${desc}</small></div>`).join("")}</div>
      <div class="end-divider"><span>PROJECT TARGETS · NOT YET VALIDATED</span><i></i></div>
      <div class="impact-grid">${targets.map(([value,label,desc])=>`<div class="impact-card"><b>${value}</b><span>${label}</span><small>${desc}</small></div>`).join("")}</div>
      <div class="end-replay"><p><strong>See the system move.</strong><br>Run the guided healthy → source change → membrane warning → service → bypass walkthrough.</p>
        <button class="nav-button next replay-full" data-action="start-script"><span>PLAY END-TO-END</span><span aria-hidden="true">↗</span></button></div>
      <div class="synthetic-footnote">Performance figures are targets from the project abstract. Synthetic HTML demo behavior is not field validation.</div>
    </div>
  </div>`;
}

function sceneVisual(scene) {
  const metrics = getMetrics();
  switch (scene.visual) {
    case "problem": return problemVisual();
    case "purifier": return `<div class="purifier-detail">${renderPurifier({ selected: state.selectedPart })}<div class="full-path-label"><span>FEED</span><i></i><span>PRETREATMENT</span><i></i><span>PRESSURE</span><i></i><span>MEMBRANE</span><i></i><span>POST-TREATMENT</span><i></i><span>STORAGE</span></div><div class="purifier-caption"><span class="tag">AQT-1001</span><b>Domestic RO + UV purifier · schematic flow path</b><small>Tap a component in the next scene to explore its role.</small></div></div>`;
    case "parts": return componentVisual(scene);
    case "sensors": return sensorVisual();
    case "edge": return edgeVisual();
    case "formulas": return formulaVisual();
    case "mqtt": return mqttVisual();
    case "cloud": return cloudVisual();
    case "analytics": return algorithmVisual();
    case "health": return healthVisual();
    case "customer": return customerVisual();
    case "service": return serviceVisual();
    case "scenarios": return scenarioVisual();
    case "end": return endVisual();
    default: return `<div class="visual-frame"><p>Scene visualization is being prepared.</p></div>`;
  }
}

function renderScene() {
  const scene = SCENES[state.scene];
  $("#scene-kicker").textContent = scene.kicker;
  $("#scene-index").textContent = `${pad2(state.scene + 1)} — ${pad2(SCENES.length)}`;
  $("#counter-current").textContent = pad2(state.scene + 1);
  $("#rail-count").textContent = `${pad2(state.scene + 1)} / ${pad2(SCENES.length)}`;
  $("#scene-host").innerHTML = layout(scene, sceneVisual(scene), scene.visual === "end");
  updateNavigation();
  updateJourneyRibbon();
  if ($("#notes-drawer").classList.contains("is-open")) renderNotes();
  renderKey++;
}

function updateNavigation() {
  $$(".scene-link").forEach((button, index) => {
    button.classList.toggle("is-current", index === state.scene);
    button.classList.toggle("is-passed", index < state.scene);
    button.setAttribute("aria-current", index === state.scene ? "step" : "false");
  });
  $$(".progress-segment").forEach((segment, index) => {
    segment.classList.toggle("is-active", index === state.scene);
    segment.classList.toggle("is-done", index < state.scene);
  });
  $("#previous-button").disabled = state.scene === 0;
  $("#next-button").disabled = state.scene === SCENES.length - 1;
}

function zoneForScene(sceneIndex) {
  const zone = SCENES[sceneIndex].zone;
  return zone === "home" ? "home" : zone === "edge" ? "edge" : zone === "mqtt" ? "mqtt" :
    zone === "cloud" ? "cloud" : "action";
}

const ZONE_ORDER = ["home", "edge", "mqtt", "cloud", "action"];
function updateJourneyRibbon() {
  const active = zoneForScene(state.scene);
  const activeIndex = ZONE_ORDER.indexOf(active);
  $$(".journey-node").forEach((node) => {
    const index = ZONE_ORDER.indexOf(node.dataset.zone);
    node.classList.toggle("is-active", node.dataset.zone === active);
    node.classList.toggle("is-passed", index < activeIndex);
  });
}

function buildNavigation() {
  const nav = $("#scene-navigation");
  nav.innerHTML = SCENES.map((scene, index) => `<button class="scene-link" data-scene="${index}" title="${safeText(scene.title)}">
    <span class="scene-number">${pad2(index + 1)}</span><span class="scene-link-title">${scene.kicker.replace(/^\d+\s·\s/, "")}</span>
  </button>`).join("");
  const progress = $("#progress-track");
  progress.innerHTML = SCENES.map((scene, index) => `<button class="progress-segment" data-scene="${index}" aria-label="Go to scene ${index + 1}: ${safeText(scene.kicker)}"></button>`).join("");
}

function renderNotes() {
  const scene = SCENES[state.scene];
  $("#notes-content").innerHTML = `<h3>PRESENTER TALK TRACK</h3><p>${scene.notes}</p>
    <div class="blueprint-card"><h3>DEVELOPMENT BLUEPRINT</h3><p>${scene.blueprint}</p></div>
    <h3>LIVE SCENARIO</h3><p>Source: <b>${SOURCE_PROFILES[state.source].label}</b><br>Condition: <b>${FAULTS[state.fault].label}</b><br>Simulated day: <b>${state.simDay}</b></p>
    <h3>TECHNICAL GUARDRAIL</h3><p>All values and algorithms in this browser presentation are illustrative synthetic demo behavior unless explicitly identified as project targets or source formulas.</p>`;
}

function renderGlobals() {
  $("#source-select").value = state.source;
  $("#source-label").textContent = SOURCE_PROFILES[state.source].label;
  $("#motion-button").classList.toggle("is-paused", state.motionPaused);
  $("#motion-label").textContent = state.motionPaused ? "RESUME MOTION" : "PAUSE MOTION";
  $(".motion-icon").textContent = state.motionPaused ? "▶" : "Ⅱ";
  document.body.classList.toggle("paused", state.motionPaused);
}

function goToScene(index, { manual = true } = {}) {
  const target = clamp(index, 0, SCENES.length - 1);
  if (target === state.scene) return;
  if (manual) stopScript();
  const host = $("#scene-host");
  host.classList.add("scene-exit");
  setTimeout(() => {
    state.scene = target;
    syncUrl();
    renderGlobals();
    renderScene();
    const newHost = $("#scene-host");
    newHost.classList.remove("scene-exit");
    newHost.classList.remove("scene-enter");
    void newHost.offsetWidth;
    newHost.classList.add("scene-enter");
  }, 105);
}

function refreshNpfResult() {
  const m = getMetrics();
  const target = $("#npf-result");
  if (!target) return;
  target.textContent = m.npfReady ? `${m.npf.toFixed(3)} · configured demo inputs` : "Awaiting Qp, NDPref and NDP";
}

function updateLiveElements() {
  // Simulation clock updates a few live labels without replacing the current view.
  const m = getMetrics();
  const day = $("[data-live='sim-day']");
  if (day) day.textContent = state.simDay;
  refreshNpfResult();
  if ($("#notes-drawer").classList.contains("is-open")) renderNotes();
  if (state.scene === 12) {
    const put = (key, value) => {
      const element = $(`[data-live='${key}']`);
      if (element) element.textContent = value;
    };
    put("scenario-day", state.simDay);
    put("scenario-clock", state.simRunning ? "clock advancing" : "clock paused");
    put("scenario-source", m.source.label);
    put("scenario-feed", m.inputTds);
    put("scenario-fault", FAULTS[state.fault].label);
    put("scenario-output", `${m.outputTds} ppm`);
    put("scenario-passage", formatPassage(m));
    put("scenario-fill", `${m.fillTime.toFixed(0)} min`);
    put("scenario-quality", m.sensorValid ? "VALID" : "SUSPECT");
    const quality = $("[data-live='scenario-quality']");
    quality?.classList.toggle("text-red", !m.sensorValid);
  }
}

function setSource(source) {
  if (!SOURCE_PROFILES[source] || state.source === source) return;
  stopScript();
  state.source = source;
  state.simDay = 0;
  state.serviceStep = 0;
  renderGlobals();
  syncUrl();
  renderScene();
  showToast(`${SOURCE_PROFILES[source].label} profile loaded · synthetic demo values`);
}

function setFault(fault) {
  if (!FAULTS[fault]) return;
  stopScript();
  state.fault = fault;
  state.simDay = 0;
  state.serviceStep = 0;
  syncUrl();
  renderScene();
  showToast(`${FAULTS[fault].label} injected into shared simulation`);
}

function toggleSimulation() {
  state.simRunning = !state.simRunning;
  if (state.simRunning) {
    if (simulationTimer) clearInterval(simulationTimer);
    simulationTimer = setInterval(() => {
      if (state.simRunning && !state.motionPaused) {
        state.simDay += 1;
        updateLiveElements();
      }
    }, Math.max(250, 5000 / state.simSpeed));
    showToast("Accelerated simulation running · one tick represents one illustrative day");
  } else {
    showToast("Simulation clock paused");
  }
  if (state.scene === 12) renderScene();
}

function resetJourney({ keepScene = false } = {}) {
  stopScript();
  state.source = "municipal";
  state.fault = "healthy";
  state.selectedPart = "ro";
  state.selectedSensor = "input-tds";
  state.simRunning = false;
  state.simDay = 0;
  state.simSpeed = 5;
  state.serviceStep = 0;
  state.npf = { qp: "", ndpRef: "", ndp: "" };
  if (!keepScene) state.scene = 0;
  syncUrl();
  renderGlobals();
  renderScene();
  showToast("Journey reset · healthy municipal baseline");
}

function advanceService() {
  if (state.fault === "healthy" || state.fault === "sensor-malfunction") {
    showToast("No cartridge request is created for this condition.");
    return;
  }
  if (state.serviceStep < SERVICE_STEPS.length - 1) {
    state.serviceStep += 1;
    renderScene();
    showToast(`Service workflow: ${SERVICE_STEPS[state.serviceStep]}`);
  }
}

function toggleNotes(force) {
  const drawer = $("#notes-drawer");
  const open = force ?? !drawer.classList.contains("is-open");
  drawer.classList.toggle("is-open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  $("#drawer-scrim").classList.toggle("is-visible", open);
  if (open) renderNotes();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => showToast("Fullscreen is unavailable in this browser."));
  } else {
    document.exitFullscreen?.();
  }
}

function replayScene() {
  const host = $("#scene-host");
  host.classList.remove("scene-enter", "scene-exit");
  void host.offsetWidth;
  host.classList.add("scene-enter");
  showToast(`Replaying scene ${pad2(state.scene + 1)}`);
}

const END_TO_END_SCRIPT = [
  { scene: 1, source: "municipal", fault: "healthy", day: 0, service: 0, text: "Healthy purifier · baseline signals" },
  { scene: 3, source: "tanker", fault: "healthy", day: 0, service: 0, text: "Water source changes · feed pattern shifts" },
  { scene: 8, source: "tanker", fault: "ro-fouling", day: 4, service: 0, text: "RO performance trends down · forecast updates" },
  { scene: 9, source: "tanker", fault: "ro-fouling", day: 4, service: 0, text: "Filter health · uncertainty range becomes visible" },
  { scene: 10, source: "tanker", fault: "ro-fouling", day: 4, service: 0, text: "Household receives an explainable recommendation" },
  { scene: 11, source: "tanker", fault: "ro-fouling", day: 4, service: 5, text: "Inventory → serviceability → dispatch → delivery" },
  { scene: 12, source: "tanker", fault: "ro-bypass", day: 0, service: 0, text: "Separate injection · sudden bypass alert" },
  { scene: 13, source: "tanker", fault: "ro-bypass", day: 0, service: 0, text: "Safety interlocks remain an independent lane" },
];

function stopScript() {
  if (state.scriptTimer) clearTimeout(state.scriptTimer);
  state.scriptTimer = null;
  state.scriptIndex = -1;
  document.body.classList.remove("script-running");
}

function startScript() {
  stopScript();
  state.scriptIndex = 0;
  state.simRunning = false;
  document.body.classList.add("script-running");
  const runStep = () => {
    const step = END_TO_END_SCRIPT[state.scriptIndex];
    if (!step) {
      stopScript();
      showToast("End-to-end walkthrough complete · replay any scene or reset");
      return;
    }
    state.scene = step.scene;
    state.source = step.source;
    state.fault = step.fault;
    state.simDay = step.day;
    state.serviceStep = step.service;
    syncUrl();
    renderGlobals();
    renderScene();
    showToast(step.text);
    state.scriptIndex += 1;
    state.scriptTimer = setTimeout(runStep, 2600);
  };
  runStep();
}

function handleClick(event) {
  const target = event.target.closest("button, [data-part], [data-sensor], .journey-node");
  if (!target) return;
  if (target.hasAttribute("data-scene")) {
    goToScene(Number(target.dataset.scene));
    return;
  }
  if (target.dataset.part) {
    state.selectedPart = target.dataset.part;
    if ([1,2].includes(state.scene)) renderScene();
    showToast(`${PARTS[state.selectedPart].name} selected`);
    return;
  }
  if (target.dataset.sensor) {
    state.selectedSensor = target.dataset.sensor;
    if (state.scene === 3) renderScene();
    return;
  }
  if (target.dataset.fault) {
    setFault(target.dataset.fault);
    return;
  }
  if (target.dataset.zone) {
    const targetScene = SCENES.findIndex((scene) => scene.zone === target.dataset.zone);
    if (targetScene >= 0) goToScene(targetScene);
    return;
  }
  switch (target.dataset.action) {
    case "reset": resetJourney(); break;
    case "toggle-notes": toggleNotes(); break;
    case "fullscreen": toggleFullscreen(); break;
    case "toggle-motion":
      state.motionPaused = !state.motionPaused;
      renderGlobals();
      showToast(state.motionPaused ? "Ambient motion paused" : "Ambient motion resumed");
      break;
    case "replay": replayScene(); break;
    case "previous": goToScene(state.scene - 1); break;
    case "next": goToScene(state.scene + 1); break;
    case "toggle-sim": toggleSimulation(); break;
    case "advance-service": advanceService(); break;
    case "start-script": startScript(); break;
    case "use-formula-example": setSource("tanker"); break;
    case "close-notes": toggleNotes(false); break;
  }
}

function handleKeydown(event) {
  const targetTag = event.target?.tagName?.toLowerCase();
  const editing = ["input", "select", "textarea"].includes(targetTag) || event.target?.isContentEditable;
  if (editing) return;
  if ((event.key === "Enter" || event.key === " ") && event.target?.matches?.("[data-part], [data-sensor]")) {
    event.preventDefault();
    event.target.click();
    return;
  }
  // Preserve native Space/Enter activation for focused buttons.
  if (targetTag === "button" && (event.key === " " || event.key === "Enter")) return;
  if (event.key === "ArrowRight" || event.key === " ") {
    event.preventDefault();
    goToScene(state.scene + 1);
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    goToScene(state.scene - 1);
  } else if (event.key.toLowerCase() === "f") {
    toggleFullscreen();
  } else if (event.key.toLowerCase() === "n") {
    toggleNotes();
  } else if (event.key.toLowerCase() === "p") {
    state.motionPaused = !state.motionPaused;
    renderGlobals();
    showToast(state.motionPaused ? "Ambient motion paused" : "Ambient motion resumed");
  } else if (event.key.toLowerCase() === "r") {
    replayScene();
  } else if (event.key === "Escape" && $("#notes-drawer").classList.contains("is-open")) {
    toggleNotes(false);
  }
}

function init() {
  const params = new URLSearchParams(location.search);
  if (SOURCE_PROFILES[params.get("source")]) state.source = params.get("source");
  if (FAULTS[params.get("fault")]) state.fault = params.get("fault");
  const day = Number(params.get("day"));
  if (Number.isFinite(day) && day >= 0) state.simDay = Math.floor(day);
  const initialScene = location.hash.match(/^#scene-(\d{1,2})$/i);
  if (initialScene) state.scene = clamp(Number(initialScene[1]) - 1, 0, SCENES.length - 1);
  buildNavigation();
  renderGlobals();
  renderScene();
  if (location.search) syncUrl();

  document.addEventListener("click", handleClick);
  document.addEventListener("keydown", handleKeydown);
  $("#source-select").addEventListener("change", (event) => setSource(event.target.value));
  $("#fullscreen-button").addEventListener("click", toggleFullscreen);
  $("#notes-button").addEventListener("click", () => toggleNotes());
  $("#reset-button").addEventListener("click", () => resetJourney({ keepScene: true }));
  $("#motion-button").addEventListener("click", () => {
    state.motionPaused = !state.motionPaused;
    renderGlobals();
    showToast(state.motionPaused ? "Ambient motion paused" : "Ambient motion resumed");
  });
  $("#replay-button").addEventListener("click", replayScene);
  $("#previous-button").addEventListener("click", () => goToScene(state.scene - 1));
  $("#next-button").addEventListener("click", () => goToScene(state.scene + 1));
  $("#close-notes").addEventListener("click", () => toggleNotes(false));
  $("#drawer-scrim").addEventListener("click", () => toggleNotes(false));

  $("#scene-host").addEventListener("input", (event) => {
    const input = event.target.closest("[data-npf]");
    if (!input) return;
    state.npf[input.dataset.npf] = input.value;
    refreshNpfResult();
  });
  $("#scene-host").addEventListener("change", (event) => {
    if (event.target.id !== "sim-speed") return;
    state.simSpeed = Number(event.target.value) || 5;
    if (state.simRunning) {
      clearInterval(simulationTimer);
      simulationTimer = setInterval(() => {
        if (state.simRunning && !state.motionPaused) {
          state.simDay += 1;
          updateLiveElements();
        }
      }, Math.max(250, 5000 / state.simSpeed));
    }
    showToast(`Simulation speed set to ${state.simSpeed}×`);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) state.simRunning = false;
    if (state.scene === 12) renderScene();
  });
}

init();
