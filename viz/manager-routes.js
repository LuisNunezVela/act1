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
  resetPackagePhotoWidget();
  setMode("route-stops");
}

// ordena choferes idle por distancia en línea recta (su posición actual de paseo) al
// almacén; usado tanto para la preselección por defecto como para la de la IA
function rankIdleDriversByDistance(candidateDrivers, warehousePoint) {
  return candidateDrivers.map(function (d) {
    var pos = wanderPositionNow(d) || warehousePoint;
    return { driver: d, distM: haversineMeters(pos, warehousePoint) };
  }).sort(function (a, b) { return a.distM - b.distM; });
}

var driverSelectHint = document.getElementById("driver-select-hint");

function populateDriverSelect(ranked, noneMessage) {
  driverSelect.innerHTML = "";
  driverSelectHint.style.display = "none"; // solo se muestra tras analizar una foto (showDriverSelectHint)
  if (ranked.length === 0) {
    var opt = document.createElement("option");
    opt.textContent = noneMessage;
    opt.value = "";
    driverSelect.appendChild(opt);
    return;
  }
  ranked.forEach(function (r, i) {
    var opt = document.createElement("option");
    opt.value = r.driver.id;
    opt.textContent = (VEHICLE_ICONS[r.driver.vehicle_type] || "") + " " + r.driver.name + (i === 0 ? " (más cercano)" : "");
    if (i === 0) opt.selected = true;
    driverSelect.appendChild(opt);
  });
}

// ETA real por calles (no línea recta) de un chofer hasta el almacén, reusando el mismo
// cálculo del tramo de recogida real que se usará si se lo asigna
function pickupEtaText(driver, peakOn) {
  var pickupLeg = computePickupLeg(driver, peakOn);
  return pickupLeg ? fmtDuration(pickupLeg.time_s) : "desconocido";
}

// muestra hasta dos líneas: el más cercano EXACTAMENTE con el vehículo que sugirió la IA (si
// hay alguno idle), y el más cercano en general entre todos los que alcanzan (rank >= mínimo) —
// por si el más cercano en el vehículo exacto está lejos. Solo se muestra después de analizar
// una foto del encargo (ver applyPackageAnalysis), no en la preselección por defecto.
function showDriverSelectHint(vehiculoMinimo, ranked) {
  var peakOn = currentRouteDraft ? currentRouteDraft.peak_hour : false;
  var general = ranked[0].driver;
  var exactMatch = ranked.filter(function (r) { return r.driver.vehicle_type === vehiculoMinimo; })[0];

  var lines = [];
  if (exactMatch && exactMatch.driver.id !== general.id) {
    lines.push(
      "El conductor libre más cercano en " + VEHICLE_ICONS[vehiculoMinimo] + " " + VEHICLE_LABELS[vehiculoMinimo] +
      " que puede llevarlo es: <strong>" + exactMatch.driver.name + "</strong> — llega al almacén en ~" +
      pickupEtaText(exactMatch.driver, peakOn) + "."
    );
  }
  lines.push(
    "Conductor recomendado más cercano: <strong>" + general.name +
    "</strong> (" + VEHICLE_ICONS[general.vehicle_type] + " " + VEHICLE_LABELS[general.vehicle_type] +
    ") — llega al almacén en ~" + pickupEtaText(general, peakOn) + "."
  );

  driverSelectHint.style.display = "block";
  driverSelectHint.innerHTML = lines.map(function (l) { return "<p>" + l + "</p>"; }).join("");
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
    "<p class=\"hint\">" + algoNote + "</p>";

  // sugiere al chofer idle más cercano al almacén (por línea recta a su posición actual de
  // paseo), preseleccionado — el manager sigue confirmando con "Asignar" (o sube una foto del
  // encargo para que la IA sugiera el chofer según el vehículo necesario, más abajo)
  var idleDrivers = drivers.filter(function (d) { return d.status === "idle"; });
  var warehousePoint = [nodesById[warehouseId].lat, nodesById[warehouseId].lon];
  populateDriverSelect(rankIdleDriversByDistance(idleDrivers, warehousePoint), "No hay choferes disponibles");
  resetPackagePhotoWidget();

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
    if (r.data.trip_id && lastAnalyzedPackagePhoto) {
      var tripFormData = new FormData();
      tripFormData.append("photo", lastAnalyzedPackagePhoto);
      fetch(BACKEND + "/manager/trips/" + r.data.trip_id + "/photo", { method: "POST", body: tripFormData })
        .catch(function () { /* la ruta ya se asignó bien; la foto del historial es secundaria */ });
    }
    routeDraftStops = [];
    currentRouteDraft = null;
    renderRouteDraftChips();
    refreshAllNodeStyles();
    routeSummary.style.display = "none";
    routeDraftLayer.clearLayers();
    resetPackagePhotoWidget();
    setMode("none");
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
}

// ---------- foto del encargo: la IA describe qué ve y sugiere el chofer más cercano capaz ----------

var packagePhotoDrop = document.getElementById("package-photo-drop");
var packagePhotoInput = document.getElementById("package-photo-input");
var packageAnalysisResult = document.getElementById("package-analysis-result");
var lastAnalyzedPackagePhoto = null; // File subido a la IA; se adjunta al viaje en Historial si se asigna

function resetPackagePhotoWidget() {
  packagePhotoDrop.textContent = "📦 Agregar foto del paquete";
  packagePhotoDrop.classList.remove("has-photo");
  packageAnalysisResult.style.display = "none";
  packageAnalysisResult.textContent = "";
  packageAnalysisResult.classList.remove("error");
  driverSelectHint.style.display = "none";
  lastAnalyzedPackagePhoto = null;
}

packagePhotoDrop.addEventListener("click", function () { packagePhotoInput.click(); });

packagePhotoInput.addEventListener("change", function () {
  var file = packagePhotoInput.files[0];
  packagePhotoInput.value = "";
  if (!file || !currentRouteDraft) return;
  lastAnalyzedPackagePhoto = file;

  packagePhotoDrop.textContent = "📦 Analizando foto…";
  packageAnalysisResult.style.display = "none";
  packageAnalysisResult.classList.remove("error");

  var formData = new FormData();
  formData.append("photo", file);
  fetch(BACKEND + "/manager/analyze-package", { method: "POST", body: formData })
    .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
    .then(function (r) {
      packagePhotoDrop.textContent = "📦 Foto del paquete (click para cambiar)";
      packagePhotoDrop.classList.add("has-photo");
      if (!r.ok) {
        packageAnalysisResult.classList.add("error");
        packageAnalysisResult.textContent = r.data.error || "No se pudo analizar la imagen.";
        packageAnalysisResult.style.display = "block";
        return;
      }
      applyPackageAnalysis(r.data);
    })
    .catch(function () {
      packagePhotoDrop.textContent = "📦 Agregar foto del paquete";
      packagePhotoDrop.classList.remove("has-photo");
      packageAnalysisResult.classList.add("error");
      packageAnalysisResult.textContent = "No se pudo conectar con el backend (¿está corriendo en :5000?).";
      packageAnalysisResult.style.display = "block";
    });
});

// filtra choferes idle cuyo vehículo alcanza (VEHICLE_RANK) lo que la IA pidió, los reordena
// por cercanía, y preselecciona en el mismo <select> de siempre — el manager confirma con el
// botón "Asignar ruta" ya existente, sin nada nuevo que aprender
function applyPackageAnalysis(analysis) {
  var minRank = VEHICLE_RANK[analysis.vehiculo_minimo];
  var idleDrivers = drivers.filter(function (d) { return d.status === "idle"; });
  var capable = idleDrivers.filter(function (d) { return VEHICLE_RANK[d.vehicle_type] >= minRank; });
  var warehousePoint = [nodesById[warehouseId].lat, nodesById[warehouseId].lon];

  packageAnalysisResult.style.display = "block";
  if (capable.length === 0) {
    packageAnalysisResult.classList.add("error");
    packageAnalysisResult.innerHTML =
      "Puedo notar que es <strong>" + analysis.descripcion + "</strong>. Esto puede ser llevado por: " +
      VEHICLE_LABELS[analysis.vehiculo_minimo] + " o superior. Ningún chofer libre tiene ahora mismo un " +
      "vehículo con capacidad suficiente — asigná manualmente o cambiá el vehículo de algún chofer en la lista.";
    return;
  }

  var ranked = rankIdleDriversByDistance(capable, warehousePoint);
  populateDriverSelect(ranked, "No hay choferes disponibles");
  showDriverSelectHint(analysis.vehiculo_minimo, ranked);
  packageAnalysisResult.classList.remove("error");
  packageAnalysisResult.innerHTML =
    "Puedo notar que es <strong>" + analysis.descripcion + "</strong>. Esto puede ser llevado por: " +
    VEHICLE_LABELS[analysis.vehiculo_minimo] + " o superior.";
}

