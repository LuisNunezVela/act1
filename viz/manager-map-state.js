"use strict";

// ---------- mapa ----------

// recuerda posición/zoom entre recargas (localStorage, por navegador) para que
// un refresh no vuelva a mostrar todo Santa Cruz si el usuario estaba haciendo zoom
var VIEW_STORAGE_KEY = "rutacruz_manager_view";

function loadSavedView() {
  try {
    var raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (!raw) return null;
    var v = JSON.parse(raw);
    if (v && typeof v.lat === "number" && typeof v.lon === "number" && typeof v.zoom === "number") return v;
  } catch (e) { /* localStorage corrupto o inaccesible: usar la vista por defecto */ }
  return null;
}

function saveView() {
  var center = map.getCenter();
  localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify({ lat: center.lat, lon: center.lng, zoom: map.getZoom() }));
}

var savedView = loadSavedView();
var initialCenter = savedView ? [savedView.lat, savedView.lon] : [GRAPH_DATA.center.lat, GRAPH_DATA.center.lon];
var initialZoom = savedView ? savedView.zoom : 13;

var map = L.map("map", { zoomControl: true }).setView(initialCenter, initialZoom);
map.on("moveend zoomend", saveView);
var tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// recuerda la opacidad entre recargas, igual que la vista del mapa (VIEW_STORAGE_KEY):
// así un refresh (por ejemplo el auto-reload de un live server al escribirse la base de
// datos) no se siente como "la opacidad se resetea sola"
var OPACITY_STORAGE_KEY = "rutacruz_manager_opacity";
var mapOpacitySlider = document.getElementById("map-opacity-slider");
var mapOpacityValue = document.getElementById("map-opacity-value");

var savedOpacity = parseInt(localStorage.getItem(OPACITY_STORAGE_KEY), 10);
if (!isNaN(savedOpacity) && savedOpacity >= 10 && savedOpacity <= 100) {
  mapOpacitySlider.value = savedOpacity;
  mapOpacityValue.textContent = savedOpacity;
  tileLayer.setOpacity(savedOpacity / 100);
}

mapOpacitySlider.addEventListener("input", function () {
  mapOpacityValue.textContent = mapOpacitySlider.value;
  tileLayer.setOpacity(parseInt(mapOpacitySlider.value, 10) / 100);
  localStorage.setItem(OPACITY_STORAGE_KEY, mapOpacitySlider.value);
});

// slider de velocidad de simulación (1x-20x), solo para probar más rápido: escala tanto el
// tiempo de manejo como las esperas fijas del almacén/descarga (ver manager-trip-sim.js).
// driver.html siempre corre a 1x — no comparte este valor, así que si el chofer tiene el
// celular abierto mientras se prueba a >1x, va a ver el viaje avanzar más lento que en el mapa
// del manager. Se recuerda entre recargas igual que la opacidad.
var SIM_SPEED_STORAGE_KEY = "rutacruz_manager_sim_speed";
var simSpeedSlider = document.getElementById("sim-speed-slider");
var simSpeedValue = document.getElementById("sim-speed-value");

var savedSimSpeed = parseInt(localStorage.getItem(SIM_SPEED_STORAGE_KEY), 10);
if (!isNaN(savedSimSpeed) && savedSimSpeed >= 1 && savedSimSpeed <= 20) {
  SIM_SPEED_FACTOR = savedSimSpeed;
  simSpeedSlider.value = savedSimSpeed;
  simSpeedValue.textContent = savedSimSpeed + "x";
}

simSpeedSlider.addEventListener("input", function () {
  SIM_SPEED_FACTOR = parseInt(simSpeedSlider.value, 10);
  simSpeedValue.textContent = SIM_SPEED_FACTOR + "x";
  localStorage.setItem(SIM_SPEED_STORAGE_KEY, String(SIM_SPEED_FACTOR));
});

var edgeLayer = L.layerGroup().addTo(map);
var edgeLineByPair = {};
GRAPH_DATA.edges.forEach(function (e) {
  var pts = pointsBetween(e.source, e.target);
  var line = L.polyline(pts, { color: COLORS.edgeDefault, weight: 2, opacity: 0.55 }).addTo(edgeLayer);
  edgeLineByPair[canonicalKey(e.source, e.target)] = line;
});

// --- etiquetas de distancia/tiempo por calle ---
var edgeLabelLayer = L.layerGroup().addTo(map);
var edgeLabelByPair = {};

function fmtShortDuration(s) {
  return s < 60 ? Math.round(s) + " s" : Math.round(s / 60) + " min";
}

function edgeLabelText(edge, peakOn) {
  return (edge.weight / 1000).toFixed(2) + " km · " + fmtShortDuration(edgeTimeSeconds(edge, peakOn));
}

function renderEdgeLabels(peakOn) {
  GRAPH_DATA.edges.forEach(function (e) {
    var mid = polylineMidpoint(pointsBetween(e.source, e.target));
    var marker = L.marker(mid, {
      icon: L.divIcon({ className: "edge-label", html: edgeLabelText(e, peakOn), iconSize: null }),
      interactive: false,
      keyboard: false,
    }).addTo(edgeLabelLayer);
    edgeLabelByPair[canonicalKey(e.source, e.target)] = marker;
  });
}

function refreshEdgeLabels() {
  var peakOn = peakToggle.checked;
  GRAPH_DATA.edges.forEach(function (e) {
    var marker = edgeLabelByPair[canonicalKey(e.source, e.target)];
    if (marker) marker.setIcon(L.divIcon({ className: "edge-label", html: edgeLabelText(e, peakOn), iconSize: null }));
  });
}

renderEdgeLabels(false);

var routeDraftLayer = L.layerGroup().addTo(map);

var markers = {};
function nodeMarkerStyle(id) {
  var level = trafficByNode[id];
  var isWarehouse = id === warehouseId;
  var isSelected = routeDraftStops.indexOf(id) !== -1;
  return {
    radius: isWarehouse ? 10 : (isSelected ? 8 : 6),
    fillColor: COLORS[level] || COLORS.none,
    fillOpacity: 0.95,
    color: isWarehouse ? COLORS.warehouseBorder : (isSelected ? COLORS.selectedBorder : COLORS.defaultBorder),
    weight: isWarehouse || isSelected ? 3 : 1,
  };
}
function refreshNodeStyle(id) { markers[id].setStyle(nodeMarkerStyle(id)); }
function refreshAllNodeStyles() { GRAPH_DATA.nodes.forEach(function (n) { refreshNodeStyle(n.id); }); }

GRAPH_DATA.nodes.forEach(function (n) {
  var marker = L.circleMarker([n.lat, n.lon], nodeMarkerStyle(n.id)).addTo(map);
  marker.bindTooltip(n.name, { direction: "top", offset: [0, -6] });
  marker.on("click", function () { onNodeClick(n.id); });
  markers[n.id] = marker;
});

function setEdgeBlockedStyle(a, b, blocked) {
  var line = edgeLineByPair[canonicalKey(a, b)];
  if (!line) return;
  line.setStyle(blocked
    ? { color: COLORS.blocked, weight: 6, opacity: 0.9 }
    : { color: COLORS.edgeDefault, weight: 2, opacity: 0.55 });
}

// ---------- estado / DOM ----------

var statusBox = document.getElementById("status-box");
function updateStatus(text) { statusBox.textContent = text; }

var modeButtons = Array.prototype.slice.call(document.querySelectorAll(".mode-btn"));
var mode = "none";
var trafficSelectNodeId = null;
var blockDraftNodeA = null;
var currentRouteDraft = null;
var drivers = [];

var warehouseLabel = document.getElementById("warehouse-label");
var trafficWrap = document.getElementById("traffic-select-wrap");
var trafficNodeLabel = document.getElementById("traffic-node-label");
var blockedWrap = document.getElementById("blocked-wrap");
var blockedList = document.getElementById("blocked-list");
var routeDraftWrap = document.getElementById("route-draft-wrap");
var routeDraftChips = document.getElementById("route-draft-chips");
var routeSummary = document.getElementById("route-summary");
var routeSummaryBody = document.getElementById("route-summary-body");
var driverSelect = document.getElementById("driver-select");
var peakToggle = document.getElementById("peak-toggle");
peakToggle.addEventListener("change", refreshEdgeLabels);
var driverList = document.getElementById("driver-list");
var driverNameInput = document.getElementById("driver-name-input");

var driversToggleBtn = document.getElementById("drivers-toggle-btn");
var driversDrawer = document.getElementById("drivers-drawer");
var driversMinimizeBtn = document.getElementById("drivers-minimize-btn");
driversToggleBtn.addEventListener("click", function () { driversDrawer.classList.toggle("open"); });
driversMinimizeBtn.addEventListener("click", function () { driversDrawer.classList.remove("open"); });

var arrivalToastStack = document.getElementById("arrival-toast-stack");
var eventLogBody = document.getElementById("event-log-body");

var chatWidget = document.getElementById("chat-widget");
var chatToggleBtn = document.getElementById("chat-toggle-btn");
var chatMinimizeBtn = document.getElementById("chat-minimize-btn");
var chatMessages = document.getElementById("chat-messages");
var askInput = document.getElementById("ask-input");
var btnAsk = document.getElementById("btn-ask");
var btnMic = document.getElementById("btn-mic");
var eventLogDateInput = document.getElementById("event-log-date-input");
var eventLogTodayBtn = document.getElementById("event-log-today-btn");

var driverDetailPanel = document.getElementById("driver-detail-panel");
var driverDetailAvatar = document.getElementById("driver-detail-avatar");
var driverDetailName = document.getElementById("driver-detail-name");
var driverDetailStatus = document.getElementById("driver-detail-status");
var driverDetailOrigin = document.getElementById("driver-detail-origin");
var driverDetailDest = document.getElementById("driver-detail-dest");
var driverDetailProgressFill = document.getElementById("driver-detail-progress-fill");
var driverDetailKm = document.getElementById("driver-detail-km");
var driverDetailEta = document.getElementById("driver-detail-eta");
document.getElementById("driver-detail-close").addEventListener("click", function () { closeDriverDetail(); });

function setMode(newMode) {
  mode = newMode;
  trafficSelectNodeId = null;
  blockDraftNodeA = null;
  trafficWrap.style.display = "none";
  modeButtons.forEach(function (b) { b.classList.toggle("active", b.dataset.mode === mode); });
  routeDraftWrap.style.display = mode === "route-stops" ? "block" : "none";
  if (mode === "none") updateStatus("Elige una acción: fijar almacén, tráfico, bloquear una calle o armar una ruta.");
  else if (mode === "set-almacen") updateStatus("Click en un nodo del mapa para fijarlo como almacén.");
  else if (mode === "set-traffic") updateStatus("Click en un nodo para asignarle un nivel de tráfico.");
  else if (mode === "block-edge") updateStatus("Click en dos nodos conectados por una calle para bloquearla (click en el mismo nodo cancela).");
  else if (mode === "route-stops") updateStatus("Click en los nodos que quieras visitar como paradas (" + routeDraftStops.length + " seleccionada" + (routeDraftStops.length === 1 ? "" : "s") + ").");
}
modeButtons.forEach(function (btn) {
  btn.addEventListener("click", function () { setMode(btn.dataset.mode); });
});
setMode("none");

function onNodeClick(id) {
  if (mode === "set-almacen") { setWarehouse(id); return; }
  if (mode === "set-traffic") { showTrafficSelector(id); return; }
  if (mode === "block-edge") { handleBlockClick(id); return; }
  if (mode === "route-stops") { toggleRouteStop(id); return; }
}

// ---------- fetch helper ----------

function api(method, path, body) {
  return fetch(BACKEND + path, {
    method: method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(function (res) {
    return res.json().then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
  });
}

// ---------- almacén ----------

function setWarehouse(id) {
  api("POST", "/manager/warehouse", { node_id: id }).then(function (r) {
    if (!r.ok) { alert(r.data.error || "No se pudo fijar el almacén."); return; }
    warehouseId = r.data.warehouse_node_id;
    warehouseLabel.textContent = nodesById[warehouseId].name;
    refreshAllNodeStyles();
    setMode("none");
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
}

// ---------- tráfico ----------

function showTrafficSelector(id) {
  trafficSelectNodeId = id;
  trafficWrap.style.display = "block";
  trafficNodeLabel.textContent = nodesById[id].name;
  updateStatus('Nivel de tráfico para "' + nodesById[id].name + '": elige Bajo, Medio, Alto o Quitar.');
}

document.querySelectorAll(".traffic-level-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    if (!trafficSelectNodeId) return;
    var level = btn.dataset.level || null;
    api("POST", "/manager/traffic", { node_id: trafficSelectNodeId, level: level }).then(function (r) {
      if (!r.ok) { alert(r.data.error || "No se pudo actualizar el tráfico."); return; }
      trafficByNode = r.data;
      refreshNodeStyle(trafficSelectNodeId);
      refreshEdgeLabels();
    }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
  });
});

// ---------- bloqueo de calles ----------

function refreshBlockedList() {
  var keys = Object.keys(blockedPairs);
  blockedWrap.style.display = keys.length ? "block" : "none";
  blockedList.innerHTML = "";
  keys.forEach(function (key) {
    var info = blockedPairs[key];
    var row = document.createElement("div");
    row.className = "node-list-item";
    var label = document.createElement("span");
    label.textContent = nodesById[info.node_a].name + " ↔ " + nodesById[info.node_b].name +
      (info.reason ? " (" + info.reason + ")" : "");
    var btn = document.createElement("button");
    btn.className = "btn-secondary";
    btn.textContent = "Desbloquear";
    btn.style.marginBottom = "0";
    btn.addEventListener("click", function () { unblockEdge(info.node_a, info.node_b); });
    row.appendChild(label);
    row.appendChild(btn);
    blockedList.appendChild(row);
  });
}

function applyBlockedState(list) {
  // limpia estilos de bloqueos que ya no estén, aplica los vigentes
  Object.keys(blockedPairs).forEach(function (key) {
    var info = blockedPairs[key];
    setEdgeBlockedStyle(info.node_a, info.node_b, false);
  });
  blockedPairs = {};
  list.forEach(function (b) {
    blockedPairs[canonicalKey(b.node_a, b.node_b)] = b;
    setEdgeBlockedStyle(b.node_a, b.node_b, true);
  });
  refreshBlockedList();
}

// ---------- alertas de trancadera reportadas desde el celular del chofer ----------

var alertLayer = L.layerGroup().addTo(map);
var alertMarkersById = {};

function buildAlertPopupHtml(a) {
  var edgeName = nodesById[a.node_a].name + " ↔ " + nodesById[a.node_b].name;
  return '<div class="alert-popup"><p><strong>Trancadera reportada</strong></p>' +
    "<p>" + edgeName + "</p>" +
    '<button class="btn-primary alert-block-btn" style="width:100%;margin-bottom:6px;">Bloquear esta calle</button>' +
    '<button class="btn-secondary alert-dismiss-btn" style="width:100%;margin-bottom:0;">Descartar</button></div>';
}

function dismissAlert(alertId) {
  api("DELETE", "/manager/alerts/" + alertId).then(function (r) {
    if (r.ok) applyAlertsState(r.data);
  });
}

function wireAlertPopupButtons(marker, a) {
  var el = marker.getPopup().getElement();
  el.querySelector(".alert-block-btn").addEventListener("click", function () {
    blockEdgeRequest(a.node_a, a.node_b, "Trancadera reportada");
    dismissAlert(a.id); // una vez bloqueada la calle, el ❗ sobre ella ya es redundante
  });
  el.querySelector(".alert-dismiss-btn").addEventListener("click", function () { dismissAlert(a.id); });
}

function applyAlertsState(alerts) {
  var seenIds = {};
  alerts.forEach(function (a) {
    seenIds[a.id] = true;
    if (alertMarkersById[a.id]) return; // ya está pintado, no recrear (evita parpadeo del popup abierto)
    var marker = L.marker([a.lat, a.lng], {
      icon: L.divIcon({ className: "road-alert-marker", html: "❗", iconSize: null }),
    }).addTo(alertLayer);
    marker.bindPopup(buildAlertPopupHtml(a));
    marker.on("popupopen", function () { wireAlertPopupButtons(marker, a); });
    alertMarkersById[a.id] = marker;
  });
  Object.keys(alertMarkersById).forEach(function (id) {
    if (!seenIds[id]) { alertLayer.removeLayer(alertMarkersById[id]); delete alertMarkersById[id]; }
  });
}

function handleBlockClick(id) {
  if (blockDraftNodeA === null) {
    blockDraftNodeA = id;
    updateStatus('Calle a bloquear: desde "' + nodesById[id].name + '"… click en el nodo conectado.');
    return;
  }
  if (id === blockDraftNodeA) {
    blockDraftNodeA = null;
    updateStatus("Bloqueo cancelado. Click en un nodo para empezar de nuevo.");
    return;
  }
  var key = canonicalKey(blockDraftNodeA, id);
  if (blockedPairs[key]) {
    unblockEdge(blockDraftNodeA, id);
    blockDraftNodeA = null;
    return;
  }
  var edge = edgesByPair[blockDraftNodeA + "|" + id];
  if (!edge) {
    updateStatus("No hay una calle directa entre esos nodos. Click en un nodo para empezar de nuevo.");
    blockDraftNodeA = null;
    return;
  }
  var reason = window.prompt("Motivo del bloqueo (opcional):", "Bloqueado");
  if (reason === null) {
    blockDraftNodeA = null;
    updateStatus("Bloqueo cancelado. Click en un nodo para empezar de nuevo.");
    return;
  }
  blockEdgeRequest(blockDraftNodeA, id, reason || "Bloqueado");
  blockDraftNodeA = null;
}

function blockEdgeRequest(a, b, reason) {
  api("POST", "/manager/blocked-edges", { node_a: a, node_b: b, reason: reason }).then(function (r) {
    if (!r.ok) { alert(r.data.error || "No se pudo bloquear la calle."); return; }
    applyBlockedState(r.data);
    updateStatus("Calle bloqueada. Click en dos nodos para bloquear otra.");
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
}

function unblockEdge(a, b) {
  api("DELETE", "/manager/blocked-edges/" + a + "/" + b).then(function (r) {
    if (!r.ok) { alert(r.data.error || "No se pudo desbloquear la calle."); return; }
    applyBlockedState(r.data);
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
}

