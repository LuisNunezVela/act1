"use strict";

// ---------- simulación ----------

var driverMarkers = {};       // 🚚, keyed por driver.id
var driverFlagMarkers = {};   // 🚩 al llegar, keyed por driver.id
var driverTrails = {};        // {traveled, remaining}: L.Polyline, keyed por driver.id
var driverTimers = {};        // setInterval: tick de movimiento (solo mientras maneja)
var driverArrivalTimers = {}; // setTimeout: transición pendiente (llegada o fin de descarga)
var driverSimState = {};      // {hopBounds, tripRealSeconds, assignedAtMs, originName, destName, totalDistanceM}, para el panel de detalle
var driverRouteAssignedAt = {}; // {driverId: assigned_at}, para no reiniciar la animación en cada poll

function clearDriverSimTimers(driverId) {
  if (driverTimers[driverId]) { clearInterval(driverTimers[driverId]); delete driverTimers[driverId]; }
  if (driverArrivalTimers[driverId]) { clearTimeout(driverArrivalTimers[driverId]); delete driverArrivalTimers[driverId]; }
}

function ensureDriverTrail(driverId) {
  if (!driverTrails[driverId]) {
    driverTrails[driverId] = {
      traveled: L.polyline([], { color: COLORS.edgeDefault, weight: 5, opacity: 0.85 }).addTo(map),
      remaining: L.polyline([], { color: COLORS.trailRemaining, weight: 5, opacity: 0.85 }).addTo(map),
    };
  }
  return driverTrails[driverId];
}

function removeDriverTrail(driverId) {
  var trail = driverTrails[driverId];
  if (trail) { map.removeLayer(trail.traveled); map.removeLayer(trail.remaining); delete driverTrails[driverId]; }
}

function placeArrivalFlag(driverId, point) {
  if (driverFlagMarkers[driverId]) return;
  driverFlagMarkers[driverId] = L.marker(point, {
    icon: L.divIcon({ className: "driver-marker arrival-flag", html: "🚩", iconSize: null }),
  }).addTo(map);
}

function removeDriverFlag(driverId) {
  if (driverFlagMarkers[driverId]) { map.removeLayer(driverFlagMarkers[driverId]); delete driverFlagMarkers[driverId]; }
}

function removeDriverMarkerAndTrail(driverId) {
  clearDriverWander(driverId);
  if (driverMarkers[driverId]) { map.removeLayer(driverMarkers[driverId]); delete driverMarkers[driverId]; }
  removeDriverFlag(driverId);
  removeDriverTrail(driverId);
  delete driverSimState[driverId];
  delete driverRouteAssignedAt[driverId];
}

function pointAtDistanceWithinHop(points, targetDist) {
  var acc = 0;
  for (var i = 0; i < points.length - 1; i++) {
    var segLen = haversineMeters(points[i], points[i + 1]);
    if (acc + segLen >= targetDist) {
      var t = segLen === 0 ? 0 : (targetDist - acc) / segLen;
      var a = points[i], b = points[i + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc += segLen;
  }
  return points[points.length - 1];
}

function positionAtElapsed(hops, hopBounds, elapsed) {
  var b = hopBounds.filter(function (hb) { return elapsed >= hb.start && elapsed < hb.end; })[0];
  if (!b) {
    var lastHop = hops[hops.length - 1];
    return lastHop.points[lastHop.points.length - 1];
  }
  var t = b.hop.time_s === 0 ? 0 : (elapsed - b.start) / b.hop.time_s;
  return pointAtDistanceWithinHop(b.hop.points, t * b.hop.distance_m);
}

// separa el recorrido en dos listas de puntos (recorrido/restante) para pintar el trail de
// dos colores; usa el mismo cálculo que positionAtElapsed/pointAtDistanceWithinHop para que
// el punto de corte coincida exactamente con la posición del marcador del camión
function splitHopAtDistance(points, targetDist) {
  var acc = 0;
  for (var i = 0; i < points.length - 1; i++) {
    var segLen = haversineMeters(points[i], points[i + 1]);
    if (acc + segLen >= targetDist) {
      var t = segLen === 0 ? 0 : (targetDist - acc) / segLen;
      var a = points[i], b = points[i + 1];
      var point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return { before: points.slice(0, i + 1), point: point, after: points.slice(i + 1) };
    }
    acc += segLen;
  }
  return { before: points.slice(0, points.length - 1), point: points[points.length - 1], after: [] };
}

function appendHopPoints(target, points, skipFirst) {
  for (var i = skipFirst ? 1 : 0; i < points.length; i++) target.push(points[i]);
}

function computeTrailSplit(hops, hopBounds, totalTime, elapsed) {
  var e = Math.min(Math.max(elapsed, 0), totalTime);
  var b = hopBounds.filter(function (hb) { return e >= hb.start && e < hb.end; })[0];
  var bIdx = b ? hopBounds.indexOf(b) : hops.length; // sin match => e === totalTime
  var traveled = [], remaining = [];
  for (var i = 0; i < hops.length; i++) {
    if (i < bIdx) {
      appendHopPoints(traveled, hops[i].points, i > 0);
    } else if (i === bIdx) {
      var t = b.hop.time_s === 0 ? 0 : (e - b.start) / b.hop.time_s;
      var split = splitHopAtDistance(hops[i].points, t * hops[i].distance_m);
      appendHopPoints(traveled, split.before, i > 0);
      traveled.push(split.point);
      remaining.push(split.point);
      appendHopPoints(remaining, split.after, false);
    } else {
      appendHopPoints(remaining, hops[i].points, true);
    }
  }
  return { traveled: traveled, remaining: remaining };
}

function updateDriverTrail(driverId, hops, hopBounds, totalTime, elapsed) {
  var trail = ensureDriverTrail(driverId);
  var split = computeTrailSplit(hops, hopBounds, totalTime, elapsed);
  trail.traveled.setLatLngs(split.traveled);
  trail.remaining.setLatLngs(split.remaining);
}

// arma los hops del tramo de recogida: si el chofer fue asignado a mitad de un hop de su
// paseo (pickup_partial_from/to), el primer hop es el REMANENTE de esa calle desde su
// posición exacta (pickup_partial_start_dist_m) en vez de arrancar del nodo más cercano —
// así la animación empieza justo donde estaba, sin "teletransportarse" al nodo.
function buildPickupHops(route, peakOn) {
  var hops = [];
  if (route.pickup_partial_from && route.pickup_partial_to) {
    var edge = edgesByPair[route.pickup_partial_from + "|" + route.pickup_partial_to];
    if (edge) {
      var split = splitHopAtDistance(pointsBetween(route.pickup_partial_from, route.pickup_partial_to), route.pickup_partial_start_dist_m || 0);
      var remainingDist = Math.max(0, edge.weight - (route.pickup_partial_start_dist_m || 0));
      var remainingTime = edge.weight === 0 ? 0 : edgeTimeSeconds(edge, peakOn) * (remainingDist / edge.weight);
      hops.push({
        from: route.pickup_partial_from, to: route.pickup_partial_to,
        points: [split.point].concat(split.after),
        distance_m: remainingDist, time_s: remainingTime,
      });
    }
  }
  return hops.concat(buildHopsFromNodePath(route.pickup_node_path, peakOn));
}

// driver.route.assigned_at permite RETOMAR una simulación en curso (por ejemplo, tras
// recargar la página) desde el tiempo real transcurrido en vez de reiniciarla desde cero.
// Cinco fases posibles según cuánto tiempo real pasó desde assigned_at, cada una con su
// franja fija de segundos reales a partir de assigned_at:
//   A) yendo al almacén (recogiendo pedido)  -> [0, T1)
//   B) esperando en el almacén               -> [T1, T2)  espera fija WAREHOUSE_WAIT_S
//   C) entregando (almacén -> paradas)        -> [T2, T3)
//   D) llegó, esperando descarga              -> [T3, T4)  espera fija UNLOAD_WAIT_S
//   E) todo ya terminó                        -> [T4, ∞)  finaliza de inmediato, sin aviso (evento viejo)
// Las dos esperas fijas también se escalan por SIM_SPEED_FACTOR (slider de velocidad de
// simulación), igual que el tiempo de manejo, para que sirva para probar rápido.
function startDriverSimulation(driver) {
  clearDriverSimTimers(driver.id);
  clearDriverWander(driver.id);
  delete driverWanderAnchorSeen[driver.id];
  removeDriverFlag(driver.id); // limpia una bandera de una simulación previa si se re-entra

  var peakOn = driver.route.peak_hour;
  var pickupHops = buildPickupHops(driver.route, peakOn);
  var deliveryHops = buildHopsFromNodePath(driver.route.node_path, peakOn);
  if (pickupHops.length === 0 && deliveryHops.length === 0) return;

  function withBounds(hops) {
    var cum = 0;
    var bounds = hops.map(function (h) { var start = cum; cum += h.time_s; return { start: start, end: cum, hop: h }; });
    return { hops: hops, bounds: bounds, totalSimTime: cum };
  }
  var pickup = withBounds(pickupHops);
  var delivery = withBounds(deliveryHops);

  var pickupTripRealSeconds = pickup.totalSimTime / SIM_SPEED_FACTOR;
  var deliveryTripRealSeconds = delivery.totalSimTime / SIM_SPEED_FACTOR;

  // las esperas fijas también se escalan por SIM_SPEED_FACTOR (slider de velocidad) para que
  // sirvan de verdad para probar rápido; a 1x se comportan como espera real fija de siempre
  var T1 = pickupTripRealSeconds;                    // llega al almacén
  var T2 = T1 + WAREHOUSE_WAIT_S / SIM_SPEED_FACTOR; // sale del almacén, empieza la entrega
  var T3 = T2 + deliveryTripRealSeconds;              // llega al destino final
  var T4 = T3 + UNLOAD_WAIT_S / SIM_SPEED_FACTOR;    // termina la descarga

  var assignedAtMs = driver.route.assigned_at ? new Date(driver.route.assigned_at).getTime() : Date.now();
  var realElapsedSinceAssign = Math.max(0, (Date.now() - assignedAtMs) / 1000);

  var warehousePoint = pickup.hops.length
    ? pickup.hops[pickup.hops.length - 1].points[pickup.hops[pickup.hops.length - 1].points.length - 1]
    : (delivery.hops.length ? delivery.hops[0].points[0] : null);
  var destPoint = delivery.hops.length
    ? delivery.hops[delivery.hops.length - 1].points[delivery.hops[delivery.hops.length - 1].points.length - 1]
    : warehousePoint;

  var pickupNodePath = driver.route.pickup_node_path, nodePath = driver.route.node_path;
  driverSimState[driver.id] = {
    assignedAtMs: assignedAtMs, T1: T1, T2: T2, T3: T3, T4: T4,
    pickupHopBounds: pickup.bounds,
    pickupTotalDistanceM: pickup.hops.reduce(function (s, h) { return s + h.distance_m; }, 0),
    pickupOriginName: driver.route.pickup_partial_from ? "Posición actual" : nodesById[pickupNodePath[0]].name,
    pickupDestName: nodesById[pickupNodePath[pickupNodePath.length - 1]].name,
    deliveryHopBounds: delivery.bounds,
    deliveryTotalDistanceM: delivery.hops.reduce(function (s, h) { return s + h.distance_m; }, 0),
    deliveryOriginName: nodesById[nodePath[0]].name,
    deliveryDestName: nodesById[nodePath[nodePath.length - 1]].name,
  };

  if (driverMarkers[driver.id]) { map.removeLayer(driverMarkers[driver.id]); delete driverMarkers[driver.id]; }

  function placeTruckAt(pos) {
    var icon = VEHICLE_ICONS[driver.vehicle_type] || "🚚";
    var marker = L.marker(pos, { icon: L.divIcon({ className: "driver-marker", html: icon, iconSize: null }) }).addTo(map);
    marker.bindTooltip(driver.name, { direction: "top", offset: [0, -10] });
    marker.on("click", function () { openDriverDetail(driver.id); });
    driverMarkers[driver.id] = marker;
    return marker;
  }

  // Fase E: recogida + espera + entrega + descarga ya pasaron mientras la página estaba cerrada.
  if (realElapsedSinceAssign >= T4) {
    placeTruckAt(destPoint);
    placeArrivalFlag(driver.id, destPoint);
    finalizeArrival(driver, { suppressToast: true });
    return;
  }

  // Fase D: llegó al destino, esperando que termine la descarga (camión + bandera fijos).
  if (realElapsedSinceAssign >= T3) {
    placeTruckAt(destPoint);
    updateDriverTrail(driver.id, delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
    placeArrivalFlag(driver.id, destPoint);
    driverArrivalTimers[driver.id] = setTimeout(function () { finalizeArrival(driver); }, (T4 - realElapsedSinceAssign) * 1000);
    return;
  }

  // Fase C: entregando (almacén -> paradas). Se llama tanto al resumir directo en esta fase
  // como al terminar la espera en el almacén (transición en vivo, más abajo).
  function startDeliveringPhase(realElapsedIntoPhase) {
    clearDriverWander(driver.id); // defensivo: nunca debería seguir vivo a esta altura del viaje
    var elapsed = realElapsedIntoPhase * SIM_SPEED_FACTOR;
    var marker = driverMarkers[driver.id] || placeTruckAt(positionAtElapsed(delivery.hops, delivery.bounds, elapsed));
    marker.setLatLng(positionAtElapsed(delivery.hops, delivery.bounds, elapsed));
    updateDriverTrail(driver.id, delivery.hops, delivery.bounds, delivery.totalSimTime, elapsed);

    driverTimers[driver.id] = setInterval(function () {
      elapsed += (SIM_TICK_MS / 1000) * SIM_SPEED_FACTOR;
      if (elapsed >= delivery.totalSimTime) {
        elapsed = delivery.totalSimTime;
        marker.setLatLng(destPoint);
        updateDriverTrail(driver.id, delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
        clearInterval(driverTimers[driver.id]);
        delete driverTimers[driver.id];
        return;
      }
      marker.setLatLng(positionAtElapsed(delivery.hops, delivery.bounds, elapsed));
      updateDriverTrail(driver.id, delivery.hops, delivery.bounds, delivery.totalSimTime, elapsed);
    }, SIM_TICK_MS);

    driverArrivalTimers[driver.id] = setTimeout(function () {
      marker.setLatLng(destPoint);
      updateDriverTrail(driver.id, delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
      if (driverTimers[driver.id]) { clearInterval(driverTimers[driver.id]); delete driverTimers[driver.id]; }
      placeArrivalFlag(driver.id, destPoint);
      driverArrivalTimers[driver.id] = setTimeout(function () { finalizeArrival(driver); }, (UNLOAD_WAIT_S / SIM_SPEED_FACTOR) * 1000);
    }, (deliveryTripRealSeconds - realElapsedIntoPhase) * 1000);
  }

  if (realElapsedSinceAssign >= T2) {
    startDeliveringPhase(realElapsedSinceAssign - T2);
    return;
  }

  // Fase B: esperando en el almacén (recogiendo el pedido). Al resumir dentro de esta franja
  // se avisa igual, mismo criterio que el resto de la simulación (no deduplica entre pestañas).
  if (realElapsedSinceAssign >= T1) {
    placeTruckAt(warehousePoint);
    placeArrivalFlag(driver.id, warehousePoint);
    showWarehouseToast(driver);
    driverArrivalTimers[driver.id] = setTimeout(function () {
      removeDriverFlag(driver.id);
      startDeliveringPhase(0);
    }, (T2 - realElapsedSinceAssign) * 1000);
    return;
  }

  // Fase A: todavía yendo al almacén a recoger el pedido.
  var elapsedPickup = realElapsedSinceAssign * SIM_SPEED_FACTOR;
  var marker = placeTruckAt(positionAtElapsed(pickup.hops, pickup.bounds, elapsedPickup));
  updateDriverTrail(driver.id, pickup.hops, pickup.bounds, pickup.totalSimTime, elapsedPickup);

  driverTimers[driver.id] = setInterval(function () {
    elapsedPickup += (SIM_TICK_MS / 1000) * SIM_SPEED_FACTOR;
    if (elapsedPickup >= pickup.totalSimTime) {
      elapsedPickup = pickup.totalSimTime;
      marker.setLatLng(warehousePoint);
      updateDriverTrail(driver.id, pickup.hops, pickup.bounds, pickup.totalSimTime, pickup.totalSimTime);
      clearInterval(driverTimers[driver.id]);
      delete driverTimers[driver.id];
      return;
    }
    marker.setLatLng(positionAtElapsed(pickup.hops, pickup.bounds, elapsedPickup));
    updateDriverTrail(driver.id, pickup.hops, pickup.bounds, pickup.totalSimTime, elapsedPickup);
  }, SIM_TICK_MS);

  driverArrivalTimers[driver.id] = setTimeout(function () {
    marker.setLatLng(warehousePoint);
    updateDriverTrail(driver.id, pickup.hops, pickup.bounds, pickup.totalSimTime, pickup.totalSimTime);
    if (driverTimers[driver.id]) { clearInterval(driverTimers[driver.id]); delete driverTimers[driver.id]; }
    placeArrivalFlag(driver.id, warehousePoint);
    showWarehouseToast(driver);
    driverArrivalTimers[driver.id] = setTimeout(function () {
      removeDriverFlag(driver.id);
      startDeliveringPhase(0);
    }, (WAREHOUSE_WAIT_S / SIM_SPEED_FACTOR) * 1000);
  }, (T1 - realElapsedSinceAssign) * 1000);
}

function finalizeArrival(driver, opts) {
  opts = opts || {};
  delete driverArrivalTimers[driver.id];
  api("POST", "/manager/drivers/" + driver.id + "/complete").then(function (r) {
    if (!r.ok) return;
    var updated = updateLocalDriver(r.data);
    removeDriverMarkerAndTrail(driver.id);
    if (r.data.was_en_ruta) {
      logEvent("🚩", updated.name + " ha llegado al destino");
      if (!opts.suppressToast) {
        showArrivalToast(updated);
        playArrivalChime();
      }
    }
  });
}

function showArrivalToast(driver) {
  var toast = document.createElement("div");
  toast.className = "arrival-toast";
  var icon = document.createElement("span");
  icon.className = "arrival-toast-icon";
  icon.textContent = "🚩";
  var text = document.createElement("span");
  text.className = "arrival-toast-text";
  var strong = document.createElement("strong");
  strong.textContent = driver.name;
  var sub = document.createElement("span");
  sub.textContent = "llegó a destino";
  text.appendChild(strong);
  text.appendChild(sub);
  toast.appendChild(icon);
  toast.appendChild(text);
  arrivalToastStack.appendChild(toast);
  setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, TOAST_AUTO_DISMISS_MS);
}

function showWarehouseToast(driver) {
  var toast = document.createElement("div");
  toast.className = "arrival-toast";
  var icon = document.createElement("span");
  icon.className = "arrival-toast-icon";
  icon.textContent = "📦";
  var text = document.createElement("span");
  text.className = "arrival-toast-text";
  var strong = document.createElement("strong");
  strong.textContent = driver.name;
  var sub = document.createElement("span");
  sub.textContent = "ha llegado al almacén — recogiendo pedido";
  text.appendChild(strong);
  text.appendChild(sub);
  toast.appendChild(icon);
  toast.appendChild(text);
  arrivalToastStack.appendChild(toast);
  setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, TOAST_AUTO_DISMISS_MS);
  playArrivalChime();
  logEvent("📦", driver.name + " ha llegado al almacén y está recogiendo el pedido");
}

var audioCtx = null;
function playArrivalChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    var now = audioCtx.currentTime;
    [660, 880].forEach(function (freq, i) {
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      var start = now + i * 0.14;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch (e) { /* Web Audio bloqueado/no disponible: el toast visual alcanza */ }
}

// ---------- panel de detalle del chofer (click en el camión 🚚) ----------

var selectedDriverId = null;
var driverDetailInterval = null;

function distanceTraveled(hopBounds, elapsed) {
  var traveledM = 0;
  for (var i = 0; i < hopBounds.length; i++) {
    var hb = hopBounds[i];
    if (elapsed >= hb.end) {
      traveledM += hb.hop.distance_m;
    } else if (elapsed > hb.start) {
      var t = hb.hop.time_s === 0 ? 0 : (elapsed - hb.start) / hb.hop.time_s;
      traveledM += t * hb.hop.distance_m;
      break;
    } else {
      break;
    }
  }
  return traveledM;
}

// Determina en cuál de las 5 fases está el chofer ahora mismo (ver comentario de
// startDriverSimulation) y devuelve el progreso relativo a esa fase, para el panel de detalle.
function computeDriverProgress(driverId) {
  var s = driverSimState[driverId];
  if (!s) return null;
  var realElapsed = Math.max(0, (Date.now() - s.assignedAtMs) / 1000);

  if (realElapsed < s.T1) {
    var traveledM = distanceTraveled(s.pickupHopBounds, realElapsed * SIM_SPEED_FACTOR);
    return {
      phase: "to_warehouse",
      progressPct: s.pickupTotalDistanceM === 0 ? 100 : Math.min(100, (traveledM / s.pickupTotalDistanceM) * 100),
      remainingM: Math.max(0, s.pickupTotalDistanceM - traveledM),
      remainingRealS: Math.max(0, s.T1 - realElapsed),
      arrived: false,
      originName: s.pickupOriginName,
      destName: s.pickupDestName,
    };
  }
  if (realElapsed < s.T2) {
    return {
      phase: "at_warehouse", progressPct: 100, remainingM: 0, remainingRealS: Math.max(0, s.T2 - realElapsed),
      arrived: true, originName: s.pickupOriginName, destName: s.pickupDestName,
    };
  }
  if (realElapsed < s.T3) {
    var traveledM2 = distanceTraveled(s.deliveryHopBounds, (realElapsed - s.T2) * SIM_SPEED_FACTOR);
    return {
      phase: "delivering",
      progressPct: s.deliveryTotalDistanceM === 0 ? 100 : Math.min(100, (traveledM2 / s.deliveryTotalDistanceM) * 100),
      remainingM: Math.max(0, s.deliveryTotalDistanceM - traveledM2),
      remainingRealS: Math.max(0, s.T3 - realElapsed),
      arrived: false,
      originName: s.deliveryOriginName,
      destName: s.deliveryDestName,
    };
  }
  return {
    phase: "unloading", progressPct: 100, remainingM: 0, remainingRealS: Math.max(0, s.T4 - realElapsed),
    arrived: true, originName: s.deliveryOriginName, destName: s.deliveryDestName,
  };
}

var PHASE_STATUS_LABEL = {
  to_warehouse: "Yendo a recoger el pedido…",
  at_warehouse: "Recogiendo pedido…",
  delivering: "En ruta",
  unloading: "Descargando…",
};

function refreshDriverDetailPanel() {
  if (!selectedDriverId) return;
  var driver = drivers.filter(function (d) { return d.id === selectedDriverId; })[0];
  if (!driver) { closeDriverDetail(); return; }

  var progress = computeDriverProgress(selectedDriverId);
  if (!progress || driver.status !== "en_ruta") {
    // ya entregó (o el chofer quedó libre): reflejar el viaje como completado en vez de cerrar de golpe
    driverDetailProgressFill.style.width = "100%";
    driverDetailKm.textContent = "0 m";
    driverDetailEta.textContent = "Entregado";
    driverDetailStatus.textContent = "Libre";
    return;
  }

  driverDetailStatus.textContent = PHASE_STATUS_LABEL[progress.phase] || "En ruta";
  driverDetailOrigin.textContent = progress.originName;
  driverDetailDest.textContent = progress.destName;
  driverDetailProgressFill.style.width = progress.progressPct.toFixed(1) + "%";
  driverDetailKm.textContent = progress.arrived ? "0 m" : fmtMeters(progress.remainingM);
  driverDetailEta.textContent = progress.phase === "at_warehouse"
    ? ("Sale en " + fmtDuration(progress.remainingRealS))
    : progress.phase === "unloading"
      ? "Llegó, descargando…"
      : ("Llega en " + fmtDuration(progress.remainingRealS));
}

function openDriverDetail(driverId) {
  var driver = drivers.filter(function (d) { return d.id === driverId; })[0];
  if (!driver) return;
  selectedDriverId = driverId;

  driverDetailName.textContent = driver.name;
  if (driver.photo_url) {
    driverDetailAvatar.style.backgroundImage = "url('" + BACKEND + driver.photo_url + "')";
    driverDetailAvatar.textContent = "";
  } else {
    driverDetailAvatar.style.backgroundImage = "";
    driverDetailAvatar.textContent = "👤";
  }

  driverDetailPanel.classList.add("open");
  refreshDriverDetailPanel();
  if (driverDetailInterval) clearInterval(driverDetailInterval);
  driverDetailInterval = setInterval(refreshDriverDetailPanel, 500);
}

function closeDriverDetail() {
  selectedDriverId = null;
  driverDetailPanel.classList.remove("open");
  if (driverDetailInterval) { clearInterval(driverDetailInterval); driverDetailInterval = null; }
}

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function fmtLogTimestamp(iso) {
  var d = new Date(iso);
  return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function localDateStr(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function isSameLocalDay(iso, dateStr) {
  return localDateStr(new Date(iso)) === dateStr;
}

// Rango [00:00, 24:00) del día local `dateStr`, expresado en ISO UTC para que
// el backend pueda filtrar con una simple comparación de strings sobre `ts`.
function dayRangeUtcIso(dateStr) {
  var parts = dateStr.split("-").map(Number);
  var start = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
  var end = new Date(parts[0], parts[1] - 1, parts[2] + 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: end.toISOString() };
}

function appendLogEntry(entry) {
  var line = document.createElement("div");
  line.className = "event-log-line";
  var ts = document.createElement("span");
  ts.className = "event-log-ts";
  ts.textContent = fmtLogTimestamp(entry.ts);
  line.appendChild(ts);
  line.appendChild(document.createTextNode((entry.icon ? entry.icon + " " : "") + entry.message));
  eventLogBody.appendChild(line);
  eventLogBody.scrollTop = eventLogBody.scrollHeight;
}

var currentLogDate = localDateStr(new Date());

function loadLogForDate(dateStr) {
  currentLogDate = dateStr;
  var range = dayRangeUtcIso(dateStr);
  eventLogBody.innerHTML = "";
  api("GET", "/manager/log?from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to)).then(function (r) {
    if (!r.ok) return;
    r.data.forEach(appendLogEntry);
  });
}

eventLogDateInput.addEventListener("change", function () {
  if (eventLogDateInput.value) loadLogForDate(eventLogDateInput.value);
});
eventLogTodayBtn.addEventListener("click", function () {
  var today = localDateStr(new Date());
  eventLogDateInput.value = today;
  loadLogForDate(today);
});

function logEvent(icon, message) {
  api("POST", "/manager/log", { icon: icon, message: message }).then(function (r) {
    if (!r.ok) return;
    if (isSameLocalDay(r.data.ts, currentLogDate)) appendLogEntry(r.data);
  });
}

