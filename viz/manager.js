(function () {
  "use strict";

  if (typeof GRAPH_DATA === "undefined" || !GRAPH_DATA.nodes || GRAPH_DATA.nodes.length === 0) {
    document.getElementById("panel").innerHTML =
      '<h1>Gestor de reparto</h1><p class="subtitle">Todavía no hay un grafo generado.</p>' +
      '<p class="hint">Genera el grafo primero desde <code>editor.html</code> y el notebook.</p>';
    return;
  }

  var BACKEND = "http://127.0.0.1:5000";

  var COLORS = {
    none: "#b9c0cf",
    bajo: "#4f7cff",
    medio: "#f5b942",
    alto: "#e5484d",
    warehouseBorder: "#7c3aed",
    selectedBorder: "#16a34a",
    defaultBorder: "#5b6478",
    blocked: "#e5484d",
    edgeDefault: "#9aa3b5",
    trailRemaining: "#14b8a6", // var(--teal); tramo por recorrer del trail
  };

  var TRAFFIC_MULTIPLIER = { bajo: 1.15, medio: 1.5, alto: 2.0 };
  var AVG_SPEED_MPS = (30 * 1000) / 3600; // 30 km/h promedio urbano
  var SIM_TICK_MS = 100;
  var SIM_SPEED_FACTOR = 1; // 1 s real = 1 s simulado (tiempo real, para revisar que todo ande bien)
  var UNLOAD_WAIT_S = 20;          // espera real fija de "descarga" al llegar — NO se escala por SIM_SPEED_FACTOR
  var TOAST_AUTO_DISMISS_MS = 6000;

  // ---------- geometry helpers (duplicados de app.js, cada página es autocontenida) ----------

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

  function pathToLatLngs(path) {
    var latlngs = [];
    for (var i = 0; i < path.length - 1; i++) {
      var pts = pointsBetween(path[i], path[i + 1]);
      var start = i === 0 ? 0 : 1;
      for (var j = start; j < pts.length; j++) latlngs.push(pts[j]);
    }
    return latlngs;
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

  // punto a la mitad de la distancia recorrida (no solo el promedio de extremos),
  // para que la etiqueta caiga sobre la línea incluso si la calle es curva
  function polylineMidpoint(pts) {
    var segLens = [], total = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      var d = haversineMeters(pts[i], pts[i + 1]);
      segLens.push(d);
      total += d;
    }
    var half = total / 2, acc = 0;
    for (var i = 0; i < segLens.length; i++) {
      if (acc + segLens[i] >= half) {
        var t = segLens[i] === 0 ? 0 : (half - acc) / segLens[i];
        var a = pts[i], b = pts[i + 1];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      acc += segLens[i];
    }
    return pts[Math.floor(pts.length / 2)];
  }

  var edgesByPair = {};
  GRAPH_DATA.edges.forEach(function (e) {
    edgesByPair[e.source + "|" + e.target] = e;
    edgesByPair[e.target + "|" + e.source] = e;
  });

  // ---------- routing: adjacency, Dijkstra, traffic, bloqueos ----------

  function buildAdjacency() {
    var adj = {};
    GRAPH_DATA.nodes.forEach(function (n) { adj[n.id] = []; });
    GRAPH_DATA.edges.forEach(function (e) {
      adj[e.source].push({ to: e.target, edge: e });
      adj[e.target].push({ to: e.source, edge: e });
    });
    return adj;
  }
  var adjacency = buildAdjacency();

  var trafficByNode = {};   // {node_id: "bajo"|"medio"|"alto"}
  var blockedPairs = {};    // {"m05|m10": {reason, blocked_at}}
  var warehouseId = null;
  var routeDraftStops = []; // usado por nodeMarkerStyle() al pintar los marcadores iniciales

  function canonicalKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }
  function isBlocked(edge) { return !!blockedPairs[canonicalKey(edge.source, edge.target)]; }

  function edgeBaseTimeSeconds(edge) { return edge.weight / AVG_SPEED_MPS; }

  function edgeTimeSeconds(edge, peakOn) {
    var base = edgeBaseTimeSeconds(edge);
    if (!peakOn) return base;
    var lvlA = trafficByNode[edge.source], lvlB = trafficByNode[edge.target];
    var mult = Math.max(TRAFFIC_MULTIPLIER[lvlA] || 1, TRAFFIC_MULTIPLIER[lvlB] || 1);
    return base * mult;
  }

  function distanceWeight(edge) { return edge.weight; }
  function timeWeight(edge) { return edgeTimeSeconds(edge, true); }

  function effectiveWeightFn(peakOn) {
    var base = peakOn ? timeWeight : distanceWeight;
    return function (edge) { return isBlocked(edge) ? Infinity : base(edge); };
  }

  function dijkstra(startId, weightFn) {
    var dist = {}, prev = {};
    GRAPH_DATA.nodes.forEach(function (n) { dist[n.id] = Infinity; });
    dist[startId] = 0;
    var unvisited = GRAPH_DATA.nodes.map(function (n) { return n.id; });
    while (unvisited.length) {
      var u = null, best = Infinity;
      unvisited.forEach(function (id) { if (dist[id] < best) { best = dist[id]; u = id; } });
      if (u === null || best === Infinity) break;
      unvisited.splice(unvisited.indexOf(u), 1);
      (adjacency[u] || []).forEach(function (a) {
        var w = weightFn(a.edge);
        if (w === Infinity) return;
        var alt = dist[u] + w;
        if (alt < dist[a.to]) { dist[a.to] = alt; prev[a.to] = u; }
      });
    }
    return { dist: dist, prev: prev };
  }

  function reconstructPath(prev, startId, endId) {
    if (startId === endId) return [startId];
    var path = [endId], cur = endId;
    while (cur !== startId) {
      cur = prev[cur];
      if (cur === undefined) return null;
      path.push(cur);
    }
    return path.reverse();
  }

  function permutations(arr) {
    if (arr.length <= 1) return [arr];
    var result = [];
    arr.forEach(function (item, i) {
      var rest = arr.slice(0, i).concat(arr.slice(i + 1));
      permutations(rest).forEach(function (p) { result.push([item].concat(p)); });
    });
    return result;
  }

  var PERMUTATION_LIMIT = 8; // 8! = 40320 combinaciones, sigue siendo instantáneo en el navegador

  function bruteForceOrder(startId, stopIds, distMaps) {
    var best = null, bestCost = Infinity;
    permutations(stopIds).forEach(function (order) {
      var cost = 0, prevNode = startId, feasible = true;
      for (var i = 0; i < order.length; i++) {
        var d = distMaps[prevNode].dist[order[i]];
        if (d === Infinity) { feasible = false; break; }
        cost += d;
        prevNode = order[i];
      }
      if (feasible && cost < bestCost) { bestCost = cost; best = order; }
    });
    return best ? { order: best, totalCost: bestCost } : null;
  }

  // vecino más cercano: heurística usada cuando hay más paradas de las que
  // el orden exacto por fuerza bruta puede resolver al instante
  function nearestNeighborOrder(startId, stopIds, distMaps) {
    var remaining = stopIds.slice();
    var order = [], current = startId, totalCost = 0;
    while (remaining.length) {
      var bestIdx = -1, bestDist = Infinity;
      remaining.forEach(function (id, i) {
        var d = distMaps[current].dist[id];
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      if (bestIdx === -1 || bestDist === Infinity) return null;
      var next = remaining.splice(bestIdx, 1)[0];
      order.push(next);
      totalCost += bestDist;
      current = next;
    }
    return { order: order, totalCost: totalCost };
  }

  function findOptimalOrder(startId, stopIds, distMaps) {
    return stopIds.length <= PERMUTATION_LIMIT
      ? bruteForceOrder(startId, stopIds, distMaps)
      : nearestNeighborOrder(startId, stopIds, distMaps);
  }

  function buildHops(startId, order, distMaps, peakOn) {
    var hops = [], prevNode = startId;
    order.forEach(function (stop) {
      var legNodes = reconstructPath(distMaps[prevNode].prev, prevNode, stop);
      for (var i = 0; i < legNodes.length - 1; i++) {
        var a = legNodes[i], b = legNodes[i + 1];
        var edge = edgesByPair[a + "|" + b];
        hops.push({
          from: a, to: b,
          points: pointsBetween(a, b),
          distance_m: edge.weight,
          time_s: edgeTimeSeconds(edge, peakOn),
        });
      }
      prevNode = stop;
    });
    return hops;
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
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  var edgeLayer = L.layerGroup().addTo(map);
  var edgeLineByPair = {};
  GRAPH_DATA.edges.forEach(function (e) {
    var pts = pointsBetween(e.source, e.target);
    var line = L.polyline(pts, { color: COLORS.edgeDefault, weight: 2, opacity: 0.55 }).addTo(edgeLayer);
    edgeLineByPair[canonicalKey(e.source, e.target)] = line;
  });

  // --- etiquetas de distancia/tiempo por calle (igual que en demo.html, + tiempo estimado) ---
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

  function finalizeRoute() {
    if (!warehouseId) { alert("Primero fija el almacén."); return; }
    if (routeDraftStops.length === 0) { alert("Selecciona al menos una parada."); return; }

    var peakOn = peakToggle.checked;
    var weightFn = effectiveWeightFn(peakOn);
    var nodesOfInterest = [warehouseId].concat(routeDraftStops);
    var distMaps = {};
    nodesOfInterest.forEach(function (id) { distMaps[id] = dijkstra(id, weightFn); });

    var result = findOptimalOrder(warehouseId, routeDraftStops, distMaps);
    if (!result) {
      alert("No hay camino posible entre el almacén y las paradas elegidas (revisa las calles bloqueadas).");
      return;
    }

    var hops = buildHops(warehouseId, result.order, distMaps, peakOn);
    var nodePath = [warehouseId];
    hops.forEach(function (h) { nodePath.push(h.to); });
    var polyline = pathToLatLngs(nodePath);
    var distance_m = hops.reduce(function (s, h) { return s + h.distance_m; }, 0);
    var time_s = hops.reduce(function (s, h) { return s + h.time_s; }, 0);

    currentRouteDraft = {
      stops: result.order, node_path: nodePath, polyline: polyline,
      distance_m: distance_m, time_s: time_s, peak_hour: peakOn,
    };

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
      idleDrivers.forEach(function (d) {
        var opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name;
        driverSelect.appendChild(opt);
      });
    }

    routeSummary.style.display = "block";
    routeDraftLayer.clearLayers();
    L.polyline(polyline, { color: "#1b2350", weight: 5, opacity: 0.85, dashArray: "8 6" }).addTo(routeDraftLayer);
  }

  function assignRoute(driverId) {
    api("POST", "/manager/drivers/" + driverId + "/assign", currentRouteDraft).then(function (r) {
      if (!r.ok) { alert(r.data.error || "No se pudo asignar la ruta."); return; }
      var merged = updateLocalDriver(r.data);
      startDriverSimulation(merged);
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

  // ---------- choferes ----------

  var photoUploadDriverId = null;
  var driverPhotoInput = document.getElementById("driver-photo-input");

  function refreshDriverList() {
    driverList.innerHTML = "";
    drivers.forEach(function (d) {
      var row = document.createElement("div");
      row.className = "node-list-item";

      var avatar = document.createElement("div");
      avatar.className = "driver-avatar";
      avatar.title = "Click para cambiar la foto";
      if (d.photo_url) {
        avatar.style.backgroundImage = "url('" + BACKEND + d.photo_url + "')";
      } else {
        avatar.textContent = "👤";
      }
      avatar.addEventListener("click", function () {
        photoUploadDriverId = d.id;
        driverPhotoInput.click();
      });
      row.appendChild(avatar);

      var label = document.createElement("span");
      label.className = "driver-label";
      var dot = document.createElement("span");
      dot.className = "dot " + (d.status === "en_ruta" ? "dot-enroute" : "dot-idle");
      label.appendChild(dot);
      label.appendChild(document.createTextNode(" " + d.name + " — " + (d.status === "en_ruta" ? "En ruta" : "Inactivo")));
      row.appendChild(label);

      if (d.status === "idle") {
        var btn = document.createElement("button");
        btn.className = "btn-secondary";
        btn.textContent = "Eliminar";
        btn.style.marginBottom = "0";
        btn.addEventListener("click", function () { deleteDriver(d.id); });
        row.appendChild(btn);
      }
      driverList.appendChild(row);
    });
  }

  driverPhotoInput.addEventListener("change", function () {
    var file = driverPhotoInput.files[0];
    driverPhotoInput.value = "";
    if (!file || !photoUploadDriverId) return;
    var driverId = photoUploadDriverId;
    var formData = new FormData();
    formData.append("photo", file);
    fetch(BACKEND + "/manager/drivers/" + driverId + "/photo", { method: "POST", body: formData })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (r) {
        if (!r.ok) { alert(r.data.error || "No se pudo subir la foto."); return; }
        updateLocalDriver(r.data);
      })
      .catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
  });

  function updateLocalDriver(updated) {
    var idx = drivers.findIndex(function (d) { return d.id === updated.id; });
    if (idx !== -1) drivers[idx] = Object.assign({}, drivers[idx], updated);
    refreshDriverList();
    return idx !== -1 ? drivers[idx] : updated;
  }

  document.getElementById("btn-add-driver").addEventListener("click", function () {
    var name = driverNameInput.value.trim();
    if (!name) return;
    api("POST", "/manager/drivers", { name: name }).then(function (r) {
      if (!r.ok) { alert(r.data.error || "No se pudo agregar el chofer."); return; }
      drivers.push(r.data);
      driverNameInput.value = "";
      refreshDriverList();
    }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
  });

  function deleteDriver(id) {
    api("DELETE", "/manager/drivers/" + id).then(function (r) {
      if (!r.ok) { alert(r.data.error || "No se pudo eliminar el chofer."); return; }
      drivers = drivers.filter(function (d) { return d.id !== id; });
      refreshDriverList();
    }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
  }

  // ---------- simulación ----------

  var driverMarkers = {};       // 🚚, keyed por driver.id
  var driverFlagMarkers = {};   // 🚩 al llegar, keyed por driver.id
  var driverTrails = {};        // {traveled, remaining}: L.Polyline, keyed por driver.id
  var driverTimers = {};        // setInterval: tick de movimiento (solo mientras maneja)
  var driverArrivalTimers = {}; // setTimeout: transición pendiente (llegada o fin de descarga)

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
    if (driverMarkers[driverId]) { map.removeLayer(driverMarkers[driverId]); delete driverMarkers[driverId]; }
    removeDriverFlag(driverId);
    removeDriverTrail(driverId);
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

  // driver.route.assigned_at permite RETOMAR una simulación en curso (por ejemplo, tras
  // recargar la página) desde el tiempo real transcurrido en vez de reiniciarla desde el
  // almacén. Tres casos posibles según cuánto tiempo real pasó desde assigned_at:
  //   A) todavía manejando           -> retoma la animación + agenda la llegada
  //   B) llegó, esperando descarga   -> camión+bandera fijos en destino, agenda el resto de la espera
  //   C) viaje + descarga ya pasaron -> finaliza de inmediato, sin animación ni aviso (evento viejo)
  // La espera de descarga (UNLOAD_WAIT_S) es tiempo REAL fijo, no se escala por SIM_SPEED_FACTOR.
  function startDriverSimulation(driver) {
    clearDriverSimTimers(driver.id);
    removeDriverFlag(driver.id); // limpia una bandera de una simulación previa si se re-entra

    var peakOn = driver.route.peak_hour;
    var hops = buildHopsFromNodePath(driver.route.node_path, peakOn);
    if (hops.length === 0) return;

    var cumTime = 0;
    var hopBounds = hops.map(function (h) {
      var start = cumTime; cumTime += h.time_s;
      return { start: start, end: cumTime, hop: h };
    });
    var totalTime = cumTime; // segundos "simulados" (ya con tráfico aplicado)

    var tripRealSeconds = totalTime / SIM_SPEED_FACTOR;
    var totalRealSecondsWithUnload = tripRealSeconds + UNLOAD_WAIT_S;

    var assignedAtMs = driver.route.assigned_at ? new Date(driver.route.assigned_at).getTime() : Date.now();
    var realElapsedSinceAssign = Math.max(0, (Date.now() - assignedAtMs) / 1000);

    var destPoint = hops[hops.length - 1].points[hops[hops.length - 1].points.length - 1];

    if (driverMarkers[driver.id]) map.removeLayer(driverMarkers[driver.id]);

    // Caso C: viaje + descarga ya terminaron mientras la página estaba cerrada/recargando.
    if (realElapsedSinceAssign >= totalRealSecondsWithUnload) {
      var markerC = L.marker(destPoint, { icon: L.divIcon({ className: "driver-marker", html: "🚚", iconSize: null }) }).addTo(map);
      markerC.bindTooltip(driver.name, { direction: "top", offset: [0, -10] });
      driverMarkers[driver.id] = markerC;
      placeArrivalFlag(driver.id, destPoint);
      finalizeArrival(driver, { suppressToast: true });
      return;
    }

    var initialPos = realElapsedSinceAssign < tripRealSeconds
      ? positionAtElapsed(hops, hopBounds, realElapsedSinceAssign * SIM_SPEED_FACTOR)
      : destPoint;
    var marker = L.marker(initialPos, { icon: L.divIcon({ className: "driver-marker", html: "🚚", iconSize: null }) }).addTo(map);
    marker.bindTooltip(driver.name, { direction: "top", offset: [0, -10] });
    driverMarkers[driver.id] = marker;

    // Caso B: ya llegó, en espera de descarga. Camión + bandera fijos en destino, sin animar.
    if (realElapsedSinceAssign >= tripRealSeconds) {
      updateDriverTrail(driver.id, hops, hopBounds, totalTime, totalTime);
      placeArrivalFlag(driver.id, destPoint);
      var remainingUnloadMs = (totalRealSecondsWithUnload - realElapsedSinceAssign) * 1000;
      driverArrivalTimers[driver.id] = setTimeout(function () { finalizeArrival(driver); }, remainingUnloadMs);
      return;
    }

    // Caso A: todavía manejando. Retoma animación + trail, agenda la transición a "descarga"
    // para el instante exacto en que el viaje debería terminar.
    var elapsed = realElapsedSinceAssign * SIM_SPEED_FACTOR;
    updateDriverTrail(driver.id, hops, hopBounds, totalTime, elapsed);

    driverTimers[driver.id] = setInterval(function () {
      elapsed += (SIM_TICK_MS / 1000) * SIM_SPEED_FACTOR;
      if (elapsed >= totalTime) {
        elapsed = totalTime;
        marker.setLatLng(destPoint);
        updateDriverTrail(driver.id, hops, hopBounds, totalTime, totalTime);
        clearInterval(driverTimers[driver.id]);
        delete driverTimers[driver.id];
        return;
      }
      marker.setLatLng(positionAtElapsed(hops, hopBounds, elapsed));
      updateDriverTrail(driver.id, hops, hopBounds, totalTime, elapsed);
    }, SIM_TICK_MS);

    driverArrivalTimers[driver.id] = setTimeout(function () {
      marker.setLatLng(destPoint);
      updateDriverTrail(driver.id, hops, hopBounds, totalTime, totalTime);
      if (driverTimers[driver.id]) { clearInterval(driverTimers[driver.id]); delete driverTimers[driver.id]; }
      placeArrivalFlag(driver.id, destPoint);
      driverArrivalTimers[driver.id] = setTimeout(function () { finalizeArrival(driver); }, UNLOAD_WAIT_S * 1000);
    }, (tripRealSeconds - realElapsedSinceAssign) * 1000);
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

  function fmtLogTimestamp(iso) {
    var d = new Date(iso);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
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

  function logEvent(icon, message) {
    api("POST", "/manager/log", { icon: icon, message: message }).then(function (r) {
      if (!r.ok) return;
      appendLogEntry(r.data);
    });
  }

  // ---------- init ----------

  function registerLocalDriver(d) { drivers.push(d); }

  api("GET", "/manager/log").then(function (r) {
    if (!r.ok) return;
    r.data.forEach(appendLogEntry);
  });

  api("GET", "/manager/state").then(function (r) {
    var state = r.data;
    warehouseId = state.warehouse_node_id;
    if (warehouseId) warehouseLabel.textContent = nodesById[warehouseId].name;
    trafficByNode = state.traffic || {};
    applyBlockedState(state.blocked_edges || []);
    refreshAllNodeStyles();

    state.drivers.forEach(function (d) {
      registerLocalDriver(d);
      if (d.status === "en_ruta" && d.route) startDriverSimulation(d);
    });
    refreshDriverList();
  }).catch(function () {
    updateStatus("No se pudo conectar con el backend (¿está corriendo en :5000?). Los datos no se guardarán.");
  });

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
})();
