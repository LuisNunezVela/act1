(function () {
  "use strict";

  if (typeof GRAPH_DATA === "undefined" || !GRAPH_DATA.nodes || GRAPH_DATA.nodes.length === 0) {
    document.body.innerHTML = "<p style=\"padding:20px;font-family:sans-serif;\">Todavía no hay un grafo generado. Genera el grafo primero desde <code>editor.html</code> y el notebook.</p>";
    return;
  }

  var BACKEND = "http://127.0.0.1:5000";

  // IMPORTANTE: estas tres constantes deben quedar numéricamente idénticas a las de
  // manager.js. La posición del camión en esta página y en la del manager se calculan
  // por separado a partir del mismo `assigned_at`; si difieren, las dos animaciones se
  // desincronizan visualmente aunque compartan los mismos datos de ruta.
  var SIM_TICK_MS = 100;
  var SIM_SPEED_FACTOR = 1;
  var UNLOAD_WAIT_S = 20;
  var WAREHOUSE_WAIT_S = 15;
  var POLL_MS = 3000;

  var COLORS = {
    edgeDefault: "#9aa3b5",
    trailRemaining: "#14b8a6",
  };

  var TRAFFIC_MULTIPLIER = { bajo: 1.15, medio: 1.5, alto: 2.0 };
  var AVG_SPEED_MPS = (30 * 1000) / 3600;

  // ---------- geometry helpers (duplicados de manager.js, cada página es autocontenida) ----------

  var nodesById = {};
  GRAPH_DATA.nodes.forEach(function (n) { nodesById[n.id] = n; });

  var edgeGeometry = {};
  GRAPH_DATA.edges.forEach(function (e) {
    var pts = e.points && e.points.length >= 2
      ? e.points
      : [[nodesById[e.source].lat, nodesById[e.source].lon], [nodesById[e.target].lat, nodesById[e.target].lon]];
    edgeGeometry[e.source + "|" + e.target] = pts;
    edgeGeometry[e.target + "|" + e.source] = pts.slice().reverse();
  });

  function pointsBetween(a, b) {
    return edgeGeometry[a + "|" + b] || [[nodesById[a].lat, nodesById[a].lon], [nodesById[b].lat, nodesById[b].lon]];
  }

  function haversineMeters(a, b) {
    var R = 6371000;
    var lat1 = (a[0] * Math.PI) / 180, lat2 = (b[0] * Math.PI) / 180;
    var dLat = ((b[0] - a[0]) * Math.PI) / 180;
    var dLon = ((b[1] - a[1]) * Math.PI) / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearingBetween(a, b) {
    var lat1 = (a[0] * Math.PI) / 180, lat2 = (b[0] * Math.PI) / 180;
    var dLon = ((b[1] - a[1]) * Math.PI) / 180;
    var y = Math.sin(dLon) * Math.cos(lat2);
    var x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function initialBearing(hops) {
    var pts = hops[0].points;
    for (var i = 0; i < pts.length - 1; i++) {
      if (haversineMeters(pts[i], pts[i + 1]) > 0.5) return bearingBetween(pts[i], pts[i + 1]);
    }
    return 0;
  }

  var edgesByPair = {};
  GRAPH_DATA.edges.forEach(function (e) {
    edgesByPair[e.source + "|" + e.target] = e;
    edgesByPair[e.target + "|" + e.source] = e;
  });

  var trafficByNode = {}; // {node_id: "bajo"|"medio"|"alto"}, refrescado en cada poll

  function edgeBaseTimeSeconds(edge) { return edge.weight / AVG_SPEED_MPS; }

  function edgeTimeSeconds(edge, peakOn) {
    var base = edgeBaseTimeSeconds(edge);
    if (!peakOn) return base;
    var lvlA = trafficByNode[edge.source], lvlB = trafficByNode[edge.target];
    var mult = Math.max(TRAFFIC_MULTIPLIER[lvlA] || 1, TRAFFIC_MULTIPLIER[lvlB] || 1);
    return base * mult;
  }

  function buildHopsFromNodePath(nodePath, peakOn) {
    var hops = [];
    for (var i = 0; i < nodePath.length - 1; i++) {
      var a = nodePath[i], b = nodePath[i + 1];
      var edge = edgesByPair[a + "|" + b];
      if (!edge) continue;
      hops.push({
        from: a, to: b,
        points: pointsBetween(a, b),
        distance_m: edge.weight,
        time_s: edgeTimeSeconds(edge, peakOn),
      });
    }
    return hops;
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
    var bIdx = b ? hopBounds.indexOf(b) : hops.length;
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

  // ---------- nearest point on the route polyline (tocar para reportar trancadera) ----------

  var MAX_SNAP_METERS = 40;

  function nearestPointOnSegment(a, b, p) {
    var dx = b[0] - a[0], dy = b[1] - a[1];
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return a;
    var t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return [a[0] + t * dx, a[1] + t * dy];
  }

  function nearestPointOnHops(hops, clickLatLng) {
    var best = null;
    hops.forEach(function (hop) {
      var pts = hop.points;
      for (var i = 0; i < pts.length - 1; i++) {
        var proj = nearestPointOnSegment(pts[i], pts[i + 1], clickLatLng);
        var d = haversineMeters(proj, clickLatLng);
        if (!best || d < best.distMeters) best = { lat: proj[0], lng: proj[1], distMeters: d, hop: hop };
      }
    });
    if (!best || best.distMeters > MAX_SNAP_METERS) return null;
    return best;
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

  // ---------- mapa ----------

  var map = L.map("map", { zoomControl: true }).setView([GRAPH_DATA.center.lat, GRAPH_DATA.center.lon], 14);
  var tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  var opacitySlider = document.getElementById("map-opacity-slider");
  if (opacitySlider) {
    opacitySlider.addEventListener("input", function () {
      tileLayer.setOpacity(Number(opacitySlider.value) / 100);
    });
  }

  var routeLine = L.polyline([], { color: "#1b2350", weight: 5, opacity: 0.85, dashArray: "8 6" }).addTo(map);
  var trailTraveled = L.polyline([], { color: COLORS.edgeDefault, weight: 5, opacity: 0.85 }).addTo(map);
  var trailRemaining = L.polyline([], { color: COLORS.trailRemaining, weight: 5, opacity: 0.85 }).addTo(map);
  var truckMarker = null;
  var flagMarker = null;
  var lastTruckPos = null;
  var lastTruckBearing = 0;

  // ---------- marcador de posición: flecha de rumbo (estilo GPS), con cámara fija que sigue al chofer ----------

  function makeArrowIcon() {
    return L.divIcon({
      className: "nav-arrow-icon",
      html: '<div class="nav-arrow-rot"><div class="nav-arrow-ring"><div class="nav-arrow-glyph"></div></div></div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function applyArrowRotation() {
    var el = truckMarker && truckMarker.getElement();
    if (!el) return;
    var rot = el.querySelector(".nav-arrow-rot");
    if (rot) rot.style.transform = "rotate(" + lastTruckBearing + "deg)";
  }

  function placeTruck(pos, bearingDeg) {
    truckMarker = L.marker(pos, { icon: makeArrowIcon() }).addTo(map);
    lastTruckPos = pos;
    lastTruckBearing = bearingDeg;
    applyArrowRotation();
    map.setView(pos, map.getZoom() < 15 ? 15 : map.getZoom());
  }

  // se llama en cada tick de la simulación: mueve el marcador, gira la flecha según el rumbo
  // real de desplazamiento y recentra la cámara, imitando el seguimiento de un GPS de verdad.
  function moveTruckTo(pos) {
    if (lastTruckPos) {
      var d = haversineMeters(lastTruckPos, pos);
      if (d > 0.5) lastTruckBearing = bearingBetween(lastTruckPos, pos);
    }
    lastTruckPos = pos;
    truckMarker.setLatLng(pos);
    applyArrowRotation();
    map.setView(pos, map.getZoom() < 15 ? 15 : map.getZoom(), { animate: false });
  }

  function updateTrail(hops, hopBounds, totalTime, elapsed) {
    var split = computeTrailSplit(hops, hopBounds, totalTime, elapsed);
    trailTraveled.setLatLngs(split.traveled);
    trailRemaining.setLatLngs(split.remaining);
  }

  function clearRouteVisuals() {
    routeLine.setLatLngs([]);
    trailTraveled.setLatLngs([]);
    trailRemaining.setLatLngs([]);
    if (truckMarker) { map.removeLayer(truckMarker); truckMarker = null; }
    if (flagMarker) { map.removeLayer(flagMarker); flagMarker = null; }
    lastTruckPos = null;
    lastTruckBearing = 0;
  }

  // ---------- banner de confirmación ----------

  var bannerEl = document.getElementById("phone-alert-banner");
  var bannerTimer = null;
  function showPhoneBanner(text) {
    bannerEl.textContent = text;
    bannerEl.classList.add("visible");
    if (bannerTimer) clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { bannerEl.classList.remove("visible"); }, 3000);
  }

  // ---------- estado del chofer trackeado ----------

  var statusEl = document.getElementById("phone-status");
  var driverSelect = document.getElementById("driver-select");

  var currentDriverId = null;
  var currentDriver = null;
  var currentHops = null;
  var trackedAssignedAt = null;
  var simTimer = null;
  var arrivalTimer = null;

  function clearSimTimers() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (arrivalTimer) { clearTimeout(arrivalTimer); arrivalTimer = null; }
  }

  function stopTracking(statusText) {
    clearSimTimers();
    clearRouteVisuals();
    currentHops = null;
    trackedAssignedAt = null;
    statusEl.textContent = statusText || "Sin ruta asignada";
  }

  function finalizeArrival(driver) {
    arrivalTimer = null;
    api("POST", "/manager/drivers/" + driver.id + "/complete").then(function () {
      stopTracking("Entregado");
    });
  }

  function arrivalFlagAt(point) {
    return L.marker(point, { icon: L.divIcon({ className: "driver-marker arrival-flag", html: "🚩", iconSize: null }) }).addTo(map);
  }

  // Reusa el mismo modelo de 5 fases que manager.js (startDriverSimulation): A) yendo al
  // almacén a recoger el pedido, B) esperando en el almacén, C) entregando (almacén -> paradas),
  // D) llegó y espera descarga, E) todo ya pasó. Así, si el celular se abre bastante después de
  // assigned_at, el camión aparece ya avanzado en la fase que corresponda, en vez de arrancar
  // de cero.
  function startTracking(driver) {
    clearSimTimers();
    clearRouteVisuals();

    var peakOn = driver.route.peak_hour;
    var pickupHops = buildHopsFromNodePath(driver.route.pickup_node_path, peakOn);
    var deliveryHops = buildHopsFromNodePath(driver.route.node_path, peakOn);
    if (pickupHops.length === 0 && deliveryHops.length === 0) return;

    function withBounds(hops) {
      var cum = 0;
      var bounds = hops.map(function (h) { var start = cum; cum += h.time_s; return { start: start, end: cum, hop: h }; });
      return { hops: hops, bounds: bounds, totalSimTime: cum };
    }
    var pickup = withBounds(pickupHops);
    var delivery = withBounds(deliveryHops);
    currentHops = pickup.hops.length ? pickup.hops : delivery.hops;

    routeLine.setLatLngs(
      pickup.hops.length ? driver.route.pickup_polyline.concat(driver.route.polyline.slice(1)) : driver.route.polyline
    );

    var pickupTripRealSeconds = pickup.totalSimTime / SIM_SPEED_FACTOR;
    var deliveryTripRealSeconds = delivery.totalSimTime / SIM_SPEED_FACTOR;

    var T1 = pickupTripRealSeconds;        // llega al almacén
    var T2 = T1 + WAREHOUSE_WAIT_S;        // sale del almacén, empieza la entrega
    var T3 = T2 + deliveryTripRealSeconds; // llega al destino final
    var T4 = T3 + UNLOAD_WAIT_S;           // termina la descarga

    var assignedAtMs = driver.route.assigned_at ? new Date(driver.route.assigned_at).getTime() : Date.now();
    var realElapsedSinceAssign = Math.max(0, (Date.now() - assignedAtMs) / 1000);

    var warehousePoint = pickup.hops.length
      ? pickup.hops[pickup.hops.length - 1].points[pickup.hops[pickup.hops.length - 1].points.length - 1]
      : (delivery.hops.length ? delivery.hops[0].points[0] : null);
    var destPoint = delivery.hops.length
      ? delivery.hops[delivery.hops.length - 1].points[delivery.hops[delivery.hops.length - 1].points.length - 1]
      : warehousePoint;
    var bearingHops = delivery.hops.length ? delivery.hops : pickup.hops;

    // Fase E: recogida + espera + entrega + descarga ya pasaron mientras el celular estaba cerrado.
    if (realElapsedSinceAssign >= T4) {
      placeTruck(destPoint, initialBearing(bearingHops));
      flagMarker = arrivalFlagAt(destPoint);
      updateTrail(delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
      statusEl.textContent = "Entregado";
      finalizeArrival(driver);
      return;
    }

    // Fase D: llegó al destino, esperando que termine la descarga.
    if (realElapsedSinceAssign >= T3) {
      placeTruck(destPoint, initialBearing(bearingHops));
      updateTrail(delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
      flagMarker = arrivalFlagAt(destPoint);
      statusEl.textContent = "Descargando…";
      arrivalTimer = setTimeout(function () { finalizeArrival(driver); }, (T4 - realElapsedSinceAssign) * 1000);
      return;
    }

    // Fase C: entregando (almacén -> paradas). Se llama tanto al resumir directo en esta fase
    // como al terminar la espera en el almacén (transición en vivo, más abajo).
    function startDeliveringPhase(realElapsedIntoPhase) {
      currentHops = delivery.hops;
      var elapsed = realElapsedIntoPhase * SIM_SPEED_FACTOR;
      var pos = positionAtElapsed(delivery.hops, delivery.bounds, elapsed);
      if (!truckMarker) placeTruck(pos, initialBearing(delivery.hops)); else moveTruckTo(pos);
      updateTrail(delivery.hops, delivery.bounds, delivery.totalSimTime, elapsed);
      statusEl.textContent = "En ruta";

      simTimer = setInterval(function () {
        elapsed += (SIM_TICK_MS / 1000) * SIM_SPEED_FACTOR;
        if (elapsed >= delivery.totalSimTime) {
          elapsed = delivery.totalSimTime;
          moveTruckTo(destPoint);
          updateTrail(delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
          clearInterval(simTimer);
          simTimer = null;
          return;
        }
        moveTruckTo(positionAtElapsed(delivery.hops, delivery.bounds, elapsed));
        updateTrail(delivery.hops, delivery.bounds, delivery.totalSimTime, elapsed);
      }, SIM_TICK_MS);

      arrivalTimer = setTimeout(function () {
        moveTruckTo(destPoint);
        updateTrail(delivery.hops, delivery.bounds, delivery.totalSimTime, delivery.totalSimTime);
        if (simTimer) { clearInterval(simTimer); simTimer = null; }
        flagMarker = arrivalFlagAt(destPoint);
        statusEl.textContent = "Descargando…";
        arrivalTimer = setTimeout(function () { finalizeArrival(driver); }, UNLOAD_WAIT_S * 1000);
      }, (deliveryTripRealSeconds - realElapsedIntoPhase) * 1000);
    }

    if (realElapsedSinceAssign >= T2) {
      startDeliveringPhase(realElapsedSinceAssign - T2);
      return;
    }

    // Fase B: esperando en el almacén (recogiendo el pedido).
    if (realElapsedSinceAssign >= T1) {
      if (!truckMarker) placeTruck(warehousePoint, initialBearing(bearingHops)); else moveTruckTo(warehousePoint);
      flagMarker = arrivalFlagAt(warehousePoint);
      statusEl.textContent = "Recogiendo pedido…";
      showPhoneBanner("Llegaste al almacén — recogiendo el pedido");
      arrivalTimer = setTimeout(function () {
        if (flagMarker) { map.removeLayer(flagMarker); flagMarker = null; }
        startDeliveringPhase(0);
      }, (T2 - realElapsedSinceAssign) * 1000);
      return;
    }

    // Fase A: todavía yendo al almacén a recoger el pedido.
    currentHops = pickup.hops;
    var elapsedPickup = realElapsedSinceAssign * SIM_SPEED_FACTOR;
    placeTruck(positionAtElapsed(pickup.hops, pickup.bounds, elapsedPickup), initialBearing(pickup.hops));
    updateTrail(pickup.hops, pickup.bounds, pickup.totalSimTime, elapsedPickup);
    statusEl.textContent = "Yendo a recoger el pedido…";

    simTimer = setInterval(function () {
      elapsedPickup += (SIM_TICK_MS / 1000) * SIM_SPEED_FACTOR;
      if (elapsedPickup >= pickup.totalSimTime) {
        elapsedPickup = pickup.totalSimTime;
        moveTruckTo(warehousePoint);
        updateTrail(pickup.hops, pickup.bounds, pickup.totalSimTime, pickup.totalSimTime);
        clearInterval(simTimer);
        simTimer = null;
        return;
      }
      moveTruckTo(positionAtElapsed(pickup.hops, pickup.bounds, elapsedPickup));
      updateTrail(pickup.hops, pickup.bounds, pickup.totalSimTime, elapsedPickup);
    }, SIM_TICK_MS);

    arrivalTimer = setTimeout(function () {
      moveTruckTo(warehousePoint);
      updateTrail(pickup.hops, pickup.bounds, pickup.totalSimTime, pickup.totalSimTime);
      if (simTimer) { clearInterval(simTimer); simTimer = null; }
      flagMarker = arrivalFlagAt(warehousePoint);
      statusEl.textContent = "Recogiendo pedido…";
      showPhoneBanner("Llegaste al almacén — recogiendo el pedido");
      arrivalTimer = setTimeout(function () {
        if (flagMarker) { map.removeLayer(flagMarker); flagMarker = null; }
        startDeliveringPhase(0);
      }, WAREHOUSE_WAIT_S * 1000);
    }, (T1 - realElapsedSinceAssign) * 1000);
  }

  function applyDriverState(driver) {
    currentDriver = driver;
    if (!driver) { stopTracking("Chofer no encontrado"); return; }

    if (driver.status === "en_ruta" && driver.route) {
      if (trackedAssignedAt === driver.route.assigned_at) return; // ya se está animando, no reiniciar
      trackedAssignedAt = driver.route.assigned_at;
      startTracking(driver);
    } else if (trackedAssignedAt !== null) {
      stopTracking(driver.status === "idle" ? "Sin ruta asignada" : "—");
    } else {
      statusEl.textContent = "Sin ruta asignada";
    }
  }

  // ---------- tocar el mapa para reportar una trancadera ----------

  map.on("click", function (e) {
    if (!currentHops || !currentDriver || currentDriver.status !== "en_ruta") return;
    var hit = nearestPointOnHops(currentHops, [e.latlng.lat, e.latlng.lng]);
    if (!hit) { showPhoneBanner("Toca más cerca de la ruta"); return; }

    var optimisticMarker = L.marker([hit.lat, hit.lng], {
      icon: L.divIcon({ className: "road-alert-marker", html: "❗", iconSize: null }),
    }).addTo(map);
    showPhoneBanner("Trancadera reportada");

    api("POST", "/manager/alerts", {
      driver_id: currentDriver.id, node_a: hit.hop.from, node_b: hit.hop.to,
      lat: hit.lat, lng: hit.lng,
    }).then(function (r) {
      if (!r.ok) { map.removeLayer(optimisticMarker); showPhoneBanner(r.data.error || "No se pudo reportar."); }
    }).catch(function () { map.removeLayer(optimisticMarker); showPhoneBanner("No se pudo conectar con el backend."); });
  });

  // ---------- selección de chofer ----------

  function setUrlDriver(id) {
    var url = new URL(window.location.href);
    url.searchParams.set("driver", id);
    window.history.replaceState(null, "", url.toString());
  }

  function switchDriver(id) {
    if (id === currentDriverId) return;
    currentDriverId = id;
    setUrlDriver(id);
    stopTracking("Cargando…");
    currentDriver = null;
    api("GET", "/manager/state").then(function (r) {
      if (!r.ok) return;
      trafficByNode = r.data.traffic || {};
      var driver = r.data.drivers.filter(function (d) { return d.id === id; })[0];
      applyDriverState(driver || null);
    });
  }

  driverSelect.addEventListener("change", function () {
    switchDriver(driverSelect.value);
  });

  function populateDriverSelect(drivers, selectedId) {
    driverSelect.innerHTML = "";
    drivers.forEach(function (d) {
      var opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.name;
      driverSelect.appendChild(opt);
    });
    if (selectedId) driverSelect.value = selectedId;
  }

  // ---------- polling ----------

  function poll() {
    api("GET", "/manager/state").then(function (r) {
      if (!r.ok) return;
      trafficByNode = r.data.traffic || {};
      var driverExists = r.data.drivers.some(function (d) { return d.id === currentDriverId; });
      if (!driverSelect.matches(":focus")) populateDriverSelect(r.data.drivers, currentDriverId);
      if (!currentDriverId || !driverExists) return;
      var driver = r.data.drivers.filter(function (d) { return d.id === currentDriverId; })[0];
      applyDriverState(driver);
    }).catch(function () { /* poll silencioso: no interrumpir la animación local por un fallo de red puntual */ });
  }

  // ---------- init ----------

  api("GET", "/manager/state").then(function (r) {
    if (!r.ok) { statusEl.textContent = "No se pudo conectar con el backend"; return; }
    var state = r.data;
    trafficByNode = state.traffic || {};
    var drivers = state.drivers || [];
    if (drivers.length === 0) { statusEl.textContent = "No hay choferes registrados"; return; }

    var paramId = new URLSearchParams(window.location.search).get("driver");
    var initialId = (paramId && drivers.some(function (d) { return d.id === paramId; })) ? paramId : drivers[0].id;

    populateDriverSelect(drivers, initialId);
    currentDriverId = initialId;
    setUrlDriver(initialId);

    var driver = drivers.filter(function (d) { return d.id === initialId; })[0];
    applyDriverState(driver);

    setInterval(poll, POLL_MS);
  }).catch(function () {
    statusEl.textContent = "No se pudo conectar con el backend (¿está corriendo en :5000?).";
  });
})();
