(function () {
  "use strict";

  if (typeof GRAPH_DATA === "undefined" || !GRAPH_DATA.nodes || GRAPH_DATA.nodes.length === 0) {
    document.getElementById("panel").innerHTML =
      '<h1>RutaCruz</h1><p class="subtitle">Todavía no hay un grafo generado.</p>' +
      '<p class="hint">1. Abre <code>editor.html</code> y traza los nodos/calles reales.<br>' +
      "2. Guarda <code>manual_graph.json</code> en la carpeta <code>data/</code>.<br>" +
      "3. Corre el notebook <code>reparto_santa_cruz.ipynb</code> para generar los datos.<br>" +
      "4. Vuelve a abrir esta página.</p>";
    return;
  }

  var COLORS = {
    unvisited: "#b9c0cf",
    frontier: "#f5b942",
    visited: "#4f7cff",
    current: "#e5484d",
    path: "#16a34a",
    role: "#7c3aed",
    goal: "#f59e0b",
  };

  var nodesById = {};
  GRAPH_DATA.nodes.forEach(function (n) { nodesById[n.id] = n; });

  var adjacency = {};
  GRAPH_DATA.nodes.forEach(function (n) { adjacency[n.id] = []; });
  GRAPH_DATA.edges.forEach(function (e) {
    adjacency[e.source].push(e.target);
    adjacency[e.target].push(e.source);
  });

  // real traced street geometry, indexed both directions so a->b and b->a both resolve
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
      var start = i === 0 ? 0 : 1; // avoid duplicating the shared joint coordinate
      for (var j = start; j < pts.length; j++) latlngs.push(pts[j]);
    }
    return latlngs;
  }

  var map = L.map("map", { zoomControl: true }).setView(
    [GRAPH_DATA.center.lat, GRAPH_DATA.center.lon], 13
  );

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  var edgeLayer = L.layerGroup().addTo(map);
  GRAPH_DATA.edges.forEach(function (e) {
    L.polyline(pointsBetween(e.source, e.target), {
      color: "#9aa3b5",
      weight: 2,
      opacity: 0.55,
    }).addTo(edgeLayer);
  });

  var pathLayer = L.layerGroup().addTo(map);

  var markers = {};
  GRAPH_DATA.nodes.forEach(function (n) {
    var isRole = n.role === "deposito" || n.role === "cliente_ejemplo";
    var marker = L.circleMarker([n.lat, n.lon], {
      radius: isRole ? 9 : 6,
      fillColor: COLORS.unvisited,
      fillOpacity: 0.95,
      color: isRole ? COLORS.role : "#5b6478",
      weight: isRole ? 3 : 1,
    }).addTo(map);
    marker.bindTooltip(n.name, { direction: "top", offset: [0, -6] });
    marker.on("click", function () { onNodeClick(n.id); });
    markers[n.id] = marker;
  });

  function setNodeState(id, state) {
    var n = nodesById[id];
    var isRole = n.role === "deposito" || n.role === "cliente_ejemplo";
    markers[id].setStyle({
      fillColor: COLORS[state] || COLORS.unvisited,
      color: isRole ? COLORS.role : "#5b6478",
      weight: isRole ? 3 : 1,
      radius: state === "current" ? 10 : (isRole ? 9 : 6),
    });
  }

  function resetAllNodeStates() {
    GRAPH_DATA.nodes.forEach(function (n) { setNodeState(n.id, "unvisited"); });
  }

  // --- selection state ---
  var originId = null;
  var destId = null;

  var originLabel = document.getElementById("origin-label");
  var destLabel = document.getElementById("dest-label");

  function onNodeClick(id) {
    if (originId === null || (originId !== null && destId !== null)) {
      originId = id;
      destId = null;
      originLabel.textContent = nodesById[id].name;
      destLabel.textContent = "—";
      stopAnimation();
      resetAllNodeStates();
      pathLayer.clearLayers();
      clearMetrics();
      return;
    }
    if (id === originId) return; // ignore re-click on same node
    destId = id;
    destLabel.textContent = nodesById[id].name;
    loadPair(originId, destId);
  }

  document.getElementById("btn-clear-selection").addEventListener("click", function () {
    originId = null;
    destId = null;
    originLabel.textContent = "—";
    destLabel.textContent = "—";
    stopAnimation();
    resetAllNodeStates();
    pathLayer.clearLayers();
    clearMetrics();
  });

  document.getElementById("btn-reset-default").addEventListener("click", function () {
    originId = GRAPH_DATA.deposito_id;
    destId = GRAPH_DATA.cliente_id;
    originLabel.textContent = nodesById[originId].name;
    destLabel.textContent = nodesById[destId].name;
    loadPair(originId, destId);
  });

  // --- metrics panel ---
  function fmtMeters(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
  }
  function fmtTime(s) {
    return (s * 1e6).toFixed(1) + " µs";
  }

  function clearMetrics() {
    ["m-bfs-nodes", "m-dfs-nodes", "m-bfs-cost", "m-dfs-cost",
     "m-bfs-time", "m-dfs-time", "m-bfs-pathlen", "m-dfs-pathlen"].forEach(function (id) {
      var el = document.getElementById(id);
      el.textContent = "—";
      el.style.color = "";
    });
  }

  function highlightWinner(idA, idB, valA, valB) {
    var elA = document.getElementById(idA), elB = document.getElementById(idB);
    elA.style.color = ""; elB.style.color = "";
    if (valA < valB) elA.style.color = "#0f9488";
    else if (valB < valA) elB.style.color = "#0f9488";
  }

  function updateMetrics(pair) {
    document.getElementById("m-bfs-nodes").textContent = pair.bfs.nodes_explored;
    document.getElementById("m-dfs-nodes").textContent = pair.dfs.nodes_explored;
    document.getElementById("m-bfs-cost").textContent = fmtMeters(pair.bfs.cost);
    document.getElementById("m-dfs-cost").textContent = fmtMeters(pair.dfs.cost);
    document.getElementById("m-bfs-time").textContent = fmtTime(pair.bfs.time_s);
    document.getElementById("m-dfs-time").textContent = fmtTime(pair.dfs.time_s);
    document.getElementById("m-bfs-pathlen").textContent = pair.bfs.path.length;
    document.getElementById("m-dfs-pathlen").textContent = pair.dfs.path.length;
    highlightWinner("m-bfs-nodes", "m-dfs-nodes", pair.bfs.nodes_explored, pair.dfs.nodes_explored);
    highlightWinner("m-bfs-cost", "m-dfs-cost", pair.bfs.cost, pair.dfs.cost);
    highlightWinner("m-bfs-time", "m-dfs-time", pair.bfs.time_s, pair.dfs.time_s);
  }

  // --- animation ---
  var currentPair = null;
  var currentTrace = null;
  var stepIndex = 0;
  var timer = null;

  var algoSelect = document.getElementById("algo-select");
  var btnPlay = document.getElementById("btn-play");
  var btnPause = document.getElementById("btn-pause");
  var btnRestart = document.getElementById("btn-restart");
  var speedSlider = document.getElementById("speed-slider");
  var speedValue = document.getElementById("speed-value");
  var stepCounter = document.getElementById("step-counter");

  function loadPair(origin, dest) {
    var key = origin + "|" + dest;
    currentPair = GRAPH_DATA.pairs[key];
    if (!currentPair) {
      console.warn("No hay datos precalculados para", key);
      return;
    }
    updateMetrics(currentPair);
    resetAnimation();
  }

  function resetAnimation() {
    stopAnimation();
    resetAllNodeStates();
    pathLayer.clearLayers();
    if (!currentPair) return;
    currentTrace = currentPair[algoSelect.value];
    stepIndex = 0;
    stepCounter.textContent = "Paso 0 / " + currentTrace.order.length;
    // origin/dest markers keep role ring; highlight endpoints as 'frontier' colored to stand out before play
    setNodeState(originId, "current");
    setNodeState(destId, "unvisited");
    btnPlay.disabled = false;
    btnPause.disabled = true;
  }

  algoSelect.addEventListener("change", resetAnimation);
  btnRestart.addEventListener("click", resetAnimation);

  speedSlider.addEventListener("input", function () {
    speedValue.textContent = speedSlider.value;
    if (timer) { // live-adjust speed while playing
      stopTimerOnly();
      startTimerOnly();
    }
  });

  function renderStep(i) {
    var order = currentTrace.order;
    var visited = order.slice(0, i);
    var current = order[i];
    var expanded = order.slice(0, i + 1);
    var expandedSet = {};
    expanded.forEach(function (id) { expandedSet[id] = true; });

    resetAllNodeStates();

    var frontier = {};
    expanded.forEach(function (id) {
      (adjacency[id] || []).forEach(function (nb) {
        if (!expandedSet[nb]) frontier[nb] = true;
      });
    });
    Object.keys(frontier).forEach(function (id) { setNodeState(id, "frontier"); });
    visited.forEach(function (id) { setNodeState(id, "visited"); });
    setNodeState(current, "current");

    stepCounter.textContent = "Paso " + (i + 1) + " / " + order.length;
  }

  function drawFinalPath() {
    var path = currentTrace.path;
    path.forEach(function (id) { setNodeState(id, "path"); });
    // distinguish start vs end so the direction of the route is unambiguous
    // once every node in the path has turned the same green
    markers[path[0]].setStyle({ fillColor: COLORS.current, radius: 10 });
    markers[path[path.length - 1]].setStyle({ fillColor: COLORS.goal, radius: 10 });
    var latlngs = pathToLatLngs(path);
    L.polyline(latlngs, { color: COLORS.path, weight: 5, opacity: 0.9 }).addTo(pathLayer);
  }

  function tick() {
    if (!currentTrace) return;
    renderStep(stepIndex);
    if (stepIndex >= currentTrace.order.length - 1) {
      stopTimerOnly();
      drawFinalPath();
      btnPlay.disabled = false;
      btnPause.disabled = true;
      return;
    }
    stepIndex++;
  }

  function startTimerOnly() {
    timer = setInterval(tick, parseInt(speedSlider.value, 10));
  }
  function stopTimerOnly() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function stopAnimation() {
    stopTimerOnly();
    currentTrace = null;
    stepIndex = 0;
    btnPlay.disabled = true;
    btnPause.disabled = true;
    stepCounter.textContent = "Paso 0 / 0";
  }

  btnPlay.addEventListener("click", function () {
    if (!currentPair) return;
    var isFreshOrFinished = !currentTrace || stepIndex >= currentTrace.order.length - 1;
    if (isFreshOrFinished) {
      // starting from scratch, or replaying after a completed run: clear any
      // previously drawn path so it doesn't linger alongside the new one
      currentTrace = currentPair[algoSelect.value];
      stepIndex = 0;
      pathLayer.clearLayers();
      resetAllNodeStates();
    }
    btnPlay.disabled = true;
    btnPause.disabled = false;
    startTimerOnly();
  });

  btnPause.addEventListener("click", function () {
    stopTimerOnly();
    btnPlay.disabled = false;
    btnPause.disabled = true;
  });

  // --- initial default state ---
  document.getElementById("btn-reset-default").click();

  // --- debug hook (inspect from the browser console) ---
  window.__debug = {
    get originId() { return originId; },
    get destId() { return destId; },
    get currentPair() { return currentPair; },
    get currentTrace() { return currentTrace; },
    pathToLatLngs: pathToLatLngs,
    pointsBetween: pointsBetween,
    GRAPH_DATA: GRAPH_DATA,
  };
})();
