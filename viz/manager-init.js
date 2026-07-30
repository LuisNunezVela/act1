"use strict";

// ---------- polling ----------

var POLL_MS = 3000;

// Se llama una vez al cargar y luego cada POLL_MS: así el manager se entera de
// trancaderas reportadas desde el celular del chofer, y de asignaciones/llegadas
// hechas desde otra pestaña o desde el propio celular, sin reiniciar la animación
// de un camión que ya se está moviendo (solo se toca si `assigned_at` cambió).
function pollState() {
  api("GET", "/manager/state").then(function (r) {
    if (!r.ok) return;
    var state = r.data;
    warehouseId = state.warehouse_node_id;
    if (warehouseId) warehouseLabel.textContent = nodesById[warehouseId].name;
    trafficByNode = state.traffic || {};
    applyBlockedState(state.blocked_edges || []);
    refreshAllNodeStyles();

    (state.drivers || []).forEach(function (d) {
      var idx = drivers.findIndex(function (x) { return x.id === d.id; });
      if (idx === -1) drivers.push(d);
      else drivers[idx] = Object.assign({}, drivers[idx], d);

      if (d.status === "en_ruta" && d.route) {
        // defensivo: un chofer en viaje nunca debería tener su intervalo de paseo vivo (se
        // limpia al arrancar la simulación), pero si por lo que sea sobrevivió uno, aquí se
        // corta en cada poll para que no siga peleando por el mismo marcador
        clearDriverWander(d.id);
        if (driverRouteAssignedAt[d.id] !== d.route.assigned_at) {
          driverRouteAssignedAt[d.id] = d.route.assigned_at;
          startDriverSimulation(d);
        }
      } else if (d.status === "idle") {
        delete driverRouteAssignedAt[d.id];
        if (driverWanderAnchorSeen[d.id] !== d.idle_since) {
          driverWanderAnchorSeen[d.id] = d.idle_since;
          clearDriverSimTimers(d.id);
          removeDriverFlag(d.id);
          removeDriverTrail(d.id);
          startDriverWander(d);
        }
      } else if (driverMarkers[d.id]) {
        removeDriverMarkerAndTrail(d.id);
      }
    });

    applyAlertsState(state.alerts || []);
    refreshDriverList();
  }).catch(function () {
    updateStatus("No se pudo conectar con el backend (¿está corriendo en :5000?). Los datos no se guardarán.");
  });
}

// ---------- init ----------

eventLogDateInput.value = currentLogDate;
loadLogForDate(currentLogDate);

pollState();
setInterval(pollState, POLL_MS);

// ---------- debug hook ----------
window.__debugManager = {
  get warehouseId() { return warehouseId; },
  get drivers() { return drivers; },
  get trafficByNode() { return trafficByNode; },
  get blockedPairs() { return blockedPairs; },
  get mode() { return mode; },
  get routeDraftStops() { return routeDraftStops; },
  dijkstra: dijkstra,
  GRAPH_DATA: GRAPH_DATA,
  map: map,
  onNodeClick: onNodeClick,
  get driverMarkers() { return driverMarkers; },
  get driverFlagMarkers() { return driverFlagMarkers; },
  get driverTrails() { return driverTrails; },
  get driverTimers() { return driverTimers; },
  get driverArrivalTimers() { return driverArrivalTimers; },
};
