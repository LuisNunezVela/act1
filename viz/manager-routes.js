"use strict";

// ---------- construcción de ruta ----------

function renderRouteDraftChips() {
  routeDraftChips.innerHTML = "";
  routeDraftStops.forEach(function (id) {
    var chip = document.createElement("div");
    chip.className = "node-chip";
    chip.style.marginBottom = "4px";
    chip.textContent = nodesById[id].name;
    routeDraftChips.appendChild(chip);
  });
}

function toggleRouteStop(id) {
  if (id === warehouseId) { alert("El almacén no puede ser una parada."); return; }
  var idx = routeDraftStops.indexOf(id);
  if (idx !== -1) {
    routeDraftStops.splice(idx, 1);
  } else {
    routeDraftStops.push(id);
  }
  renderRouteDraftChips();
  refreshNodeStyle(id);
  setMode("route-stops");
}

function fmtMeters(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }
function fmtDuration(s) {
  var totalMin = Math.round(s / 60);
  var h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? (h + "h " + m + "min") : (m + " min");
}

document.getElementById("btn-finalize-route").addEventListener("click", finalizeRoute);
document.getElementById("btn-cancel-route").addEventListener("click", cancelRouteDraft);
document.getElementById("btn-assign-route").addEventListener("click", function () {
  if (!currentRouteDraft) return;
  var driverId = driverSelect.value;
  if (!driverId) { alert("Elige un chofer."); return; }
  assignRoute(driverId);
});

function cancelRouteDraft() {
  routeDraftStops = [];
  currentRouteDraft = null;
  renderRouteDraftChips();
  refreshAllNodeStyles();
  routeSummary.style.display = "none";
  routeDraftLayer.clearLayers();
  setMode("route-stops");
}

function computeRoute(startId, stopIds, peakOn) {
  var weightFn = effectiveWeightFn(peakOn);
  var nodesOfInterest = [startId].concat(stopIds);
  var distMaps = {};
  nodesOfInterest.forEach(function (id) { distMaps[id] = dijkstra(id, weightFn); });

  var result = findOptimalOrder(startId, stopIds, distMaps);
  if (!result) return null; // sin camino posible (calles bloqueadas)

  var hops = buildHops(startId, result.order, distMaps, peakOn);
  var nodePath = [startId];
  hops.forEach(function (h) { nodePath.push(h.to); });
  var polyline = pathToLatLngs(nodePath);
  var distance_m = hops.reduce(function (s, h) { return s + h.distance_m; }, 0);
  var time_s = hops.reduce(function (s, h) { return s + h.time_s; }, 0);

  return {
    stops: result.order, node_path: nodePath, polyline: polyline,
    distance_m: distance_m, time_s: time_s, peak_hour: peakOn,
  };
}

function finalizeRoute() {
  if (!warehouseId) { alert("Primero fija el almacén."); return; }
  if (routeDraftStops.length === 0) { alert("Selecciona al menos una parada."); return; }

  var peakOn = peakToggle.checked;
  currentRouteDraft = computeRoute(warehouseId, routeDraftStops, peakOn);
  if (!currentRouteDraft) {
    alert("No hay camino posible entre el almacén y las paradas elegidas (revisa las calles bloqueadas).");
    return;
  }
  var result = { order: currentRouteDraft.stops };
  var distance_m = currentRouteDraft.distance_m;
  var time_s = currentRouteDraft.time_s;
  var polyline = currentRouteDraft.polyline;

  var orderNames = [nodesById[warehouseId].name].concat(result.order.map(function (id) { return nodesById[id].name; }));
  var algoNote = routeDraftStops.length > PERMUTATION_LIMIT
    ? " Con más de " + PERMUTATION_LIMIT + " paradas se usa una heurística (vecino más cercano) en vez del orden exacto."
    : "";
  routeSummaryBody.innerHTML =
    "<p><strong>Orden:</strong> " + orderNames.join(" → ") + "</p>" +
    "<p><strong>Distancia:</strong> " + fmtMeters(distance_m) + " &middot; <strong>Tiempo estimado:</strong> " + fmtDuration(time_s) + "</p>" +
    "<p class=\"hint\">El orden se optimiza por distancia; con hora pico activada se optimiza por tiempo (puede rodear nodos con tráfico alto y siempre evita calles bloqueadas)." + algoNote + "</p>";

  driverSelect.innerHTML = "";
  var idleDrivers = drivers.filter(function (d) { return d.status === "idle"; });
  if (idleDrivers.length === 0) {
    var opt = document.createElement("option");
    opt.textContent = "No hay choferes disponibles";
    opt.value = "";
    driverSelect.appendChild(opt);
  } else {
    // sugiere al chofer idle más cercano al almacén (por línea recta a su posición
    // actual de paseo), preseleccionado — el manager sigue confirmando con "Asignar"
    var warehousePoint = [nodesById[warehouseId].lat, nodesById[warehouseId].lon];
    var ranked = idleDrivers.map(function (d) {
      var pos = wanderPositionNow(d) || warehousePoint;
      return { driver: d, distM: haversineMeters(pos, warehousePoint) };
    }).sort(function (a, b) { return a.distM - b.distM; });
    ranked.forEach(function (r, i) {
      var opt = document.createElement("option");
      opt.value = r.driver.id;
      opt.textContent = r.driver.name + (i === 0 ? " (más cercano)" : "");
      if (i === 0) opt.selected = true;
      driverSelect.appendChild(opt);
    });
  }

  routeSummary.style.display = "block";
  routeDraftLayer.clearLayers();
  L.polyline(polyline, { color: "#1b2350", weight: 5, opacity: 0.85, dashArray: "8 6" }).addTo(routeDraftLayer);
  // el panel puede tener más contenido del que entra en pantalla (choferes, vías
  // bloqueadas, etc.) — sin esto, "Finalizar ruta" parece no hacer nada si el resumen
  // queda debajo del scroll
  routeSummary.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// camino más corto entre dos nodos cualesquiera (usado para el resto del tramo de recogida,
// desde el nodo de destino del hop parcial hasta el almacén); reusa las mismas utilidades
// que computeRoute()
function computeLeg(startId, endId, peakOn) {
  var distMap = dijkstra(startId, effectiveWeightFn(peakOn));
  var nodePath = reconstructPath(distMap.prev, startId, endId);
  if (!nodePath) return null;
  var hops = buildHopsFromNodePath(nodePath, peakOn);
  return {
    node_path: nodePath,
    polyline: pathToLatLngs(nodePath),
    distance_m: hops.reduce(function (s, h) { return s + h.distance_m; }, 0),
    time_s: hops.reduce(function (s, h) { return s + h.time_s; }, 0),
  };
}

function hopsToLatLngs(hops) {
  var latlngs = [];
  hops.forEach(function (h, i) {
    var start = i === 0 ? 0 : 1;
    for (var j = start; j < h.points.length; j++) latlngs.push(h.points[j]);
  });
  return latlngs;
}

// tramo de recogida chofer -> almacén, empezando EXACTO desde donde está el chofer ahora mismo
// (no desde el nodo más cercano): si está a mitad de un hop del paseo, arma primero un hop
// parcial desde su posición actual hasta el nodo de destino de ese hop, y recién ahí sigue con
// el camino más corto normal hasta el almacén.
function computePickupLeg(driver, peakOn) {
  var pos = currentWanderPosition(driver);
  var hops = [];

  if (pos.hopFrom) {
    var edge = edgesByPair[pos.hopFrom + "|" + pos.hopTo];
    var split = splitHopAtDistance(pointsBetween(pos.hopFrom, pos.hopTo), pos.distIntoHop_m);
    var remainingDist = Math.max(0, edge.weight - pos.distIntoHop_m);
    var remainingTime = edge.weight === 0 ? 0 : edgeTimeSeconds(edge, peakOn) * (remainingDist / edge.weight);
    hops.push({
      from: pos.hopFrom, to: pos.hopTo,
      points: [split.point].concat(split.after),
      distance_m: remainingDist, time_s: remainingTime,
    });
  }

  if (!pos.anchorNode) return null; // sin almacén fijado nunca se le asignó un ancla a este chofer
  var restLeg = computeLeg(pos.anchorNode, warehouseId, peakOn);
  if (!restLeg) return null;
  hops = hops.concat(buildHopsFromNodePath(restLeg.node_path, peakOn));

  return {
    node_path: restLeg.node_path,
    polyline: hopsToLatLngs(hops),
    distance_m: hops.reduce(function (s, h) { return s + h.distance_m; }, 0),
    time_s: hops.reduce(function (s, h) { return s + h.time_s; }, 0),
    partial_from: pos.hopFrom, partial_to: pos.hopTo, partial_start_dist_m: pos.distIntoHop_m,
  };
}

function assignRoute(driverId) {
  var driver = drivers.filter(function (d) { return d.id === driverId; })[0];
  if (!driver) { alert("Chofer no encontrado."); return; }
  var pickupLeg = computePickupLeg(driver, currentRouteDraft.peak_hour);
  if (!pickupLeg) {
    alert("No hay camino posible entre la posición actual del chofer y el almacén (revisa las calles bloqueadas).");
    return;
  }
  var body = Object.assign({}, currentRouteDraft, {
    pickup_node_path: pickupLeg.node_path,
    pickup_polyline: pickupLeg.polyline,
    pickup_distance_m: pickupLeg.distance_m,
    pickup_time_s: pickupLeg.time_s,
    pickup_partial_from: pickupLeg.partial_from || null,
    pickup_partial_to: pickupLeg.partial_to || null,
    pickup_partial_start_dist_m: pickupLeg.partial_start_dist_m || 0,
  });
  api("POST", "/manager/drivers/" + driverId + "/assign", body).then(function (r) {
    if (!r.ok) { alert(r.data.error || "No se pudo asignar la ruta."); return; }
    var merged = updateLocalDriver(r.data);
    startDriverSimulation(merged);
    driverRouteAssignedAt[merged.id] = merged.route.assigned_at;
    logEvent("🚚", merged.name + " inició un viaje (" + fmtMeters(merged.route.distance_m) + ", " + fmtDuration(merged.route.time_s) + ")");
    routeDraftStops = [];
    currentRouteDraft = null;
    renderRouteDraftChips();
    refreshAllNodeStyles();
    routeSummary.style.display = "none";
    routeDraftLayer.clearLayers();
    setMode("none");
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
}

