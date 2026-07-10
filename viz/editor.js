(function () {
  "use strict";

  var STORAGE_KEY = "rutacruz_manual_graph";
  var SANTA_CRUZ_CENTER = [-17.7833, -63.1821];

  var nodes = [];   // {id, name, lat, lon}
  var edges = [];   // {id, source, target, points: [[lat,lon], ...], cost}
  var nextNodeSeq = 0;
  var nextEdgeSeq = 0;

  var mode = "none";
  var lineDraft = null; // {sourceId, points: [[lat,lon], ...]}
  var undoStack = [];   // [{type:'node'|'edge', id}]

  var nodeMarkers = {};
  var edgeLayers = {};
  var draftPolyline = null;

  var map = L.map("map").setView(SANTA_CRUZ_CENTER, 13);
  var tileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  var mapOpacitySlider = document.getElementById("map-opacity-slider");
  var mapOpacityValue = document.getElementById("map-opacity-value");
  mapOpacitySlider.addEventListener("input", function () {
    mapOpacityValue.textContent = mapOpacitySlider.value;
    tileLayer.setOpacity(parseInt(mapOpacitySlider.value, 10) / 100);
  });

  var statusBox = document.getElementById("status-box");
  var nodeCountEl = document.getElementById("node-count");
  var edgeCountEl = document.getElementById("edge-count");
  var nodeListEl = document.getElementById("node-list");

  function haversineM(a, b) {
    var R = 6371000;
    var lat1 = a[0] * Math.PI / 180, lat2 = b[0] * Math.PI / 180;
    var dLat = (b[0] - a[0]) * Math.PI / 180;
    var dLon = (b[1] - a[1]) * Math.PI / 180;
    var h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function polylineLength(points) {
    var total = 0;
    for (var i = 0; i < points.length - 1; i++) total += haversineM(points[i], points[i + 1]);
    return total;
  }

  function updateStatus(text) { statusBox.textContent = text; }

  function updateCounts() {
    nodeCountEl.textContent = nodes.length + " nodo" + (nodes.length === 1 ? "" : "s");
    edgeCountEl.textContent = edges.length + " calle" + (edges.length === 1 ? "" : "s");
  }

  function refreshNodeList() {
    nodeListEl.innerHTML = "";
    nodes.forEach(function (n) {
      var row = document.createElement("div");
      row.className = "node-list-item";
      var input = document.createElement("input");
      input.value = n.name;
      input.addEventListener("change", function () {
        n.name = input.value || n.id;
        nodeMarkers[n.id].bindTooltip(n.name, { direction: "top", offset: [0, -6] });
        persist();
      });
      row.appendChild(input);
      nodeListEl.appendChild(row);
    });
  }

  function findNode(id) { return nodes.find(function (n) { return n.id === id; }); }

  // ---------- persistence ----------

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: nodes, edges: edges }));
  }

  function loadFromData(data) {
    clearAllLayers();
    nodes = data.nodes || [];
    edges = data.edges || [];
    nextNodeSeq = nodes.length;
    nextEdgeSeq = edges.length;
    nodes.forEach(drawNodeMarker);
    edges.forEach(drawEdgeLayer);
    updateCounts();
    refreshNodeList();
  }

  function tryAutoRestore() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      var data = JSON.parse(raw);
      if (data.nodes && data.nodes.length) loadFromData(data);
    } catch (e) { console.warn("No se pudo restaurar el trabajo guardado", e); }
  }

  // ---------- rendering ----------

  function clearAllLayers() {
    Object.keys(nodeMarkers).forEach(function (id) { map.removeLayer(nodeMarkers[id]); });
    Object.keys(edgeLayers).forEach(function (id) { map.removeLayer(edgeLayers[id]); });
    nodeMarkers = {};
    edgeLayers = {};
  }

  function drawNodeMarker(n) {
    var marker = L.circleMarker([n.lat, n.lon], {
      radius: 7,
      fillColor: "#4f7cff",
      fillOpacity: 0.95,
      color: "#1b2350",
      weight: 2,
    }).addTo(map);
    marker.bindTooltip(n.name, { direction: "top", offset: [0, -6] });
    marker.on("click", function (e) { L.DomEvent.stopPropagation(e); onNodeClick(n.id); });
    nodeMarkers[n.id] = marker;
  }

  function drawEdgeLayer(edge) {
    var line = L.polyline(edge.points, { color: "#0f9488", weight: 4, opacity: 0.85 }).addTo(map);
    line.bindTooltip(Math.round(edge.cost) + " m", { sticky: true });
    line.on("click", function (e) { L.DomEvent.stopPropagation(e); onEdgeClick(edge.id); });
    edgeLayers[edge.id] = line;
  }

  // ---------- mode handling ----------

  var modeButtons = Array.prototype.slice.call(document.querySelectorAll(".mode-btn"));
  modeButtons.forEach(function (btn) {
    btn.addEventListener("click", function () { setMode(btn.dataset.mode); });
  });

  function setMode(newMode) {
    if (lineDraft) cancelLineDraft();
    mode = newMode;
    modeButtons.forEach(function (b) { b.classList.toggle("active", b.dataset.mode === mode); });
    if (mode === "none") updateStatus("Modo mapa: desplázate y haz zoom sin agregar nada.");
    else if (mode === "point") updateStatus("Modo punto: click en el mapa para agregar un nodo.");
    else if (mode === "line") updateStatus("Modo línea: click en un nodo existente para empezar a trazar una calle.");
    else if (mode === "delete") updateStatus("Modo borrar: click en un nodo o una calle para eliminarla.");
  }
  setMode("none");

  function cancelLineDraft() {
    if (draftPolyline) { map.removeLayer(draftPolyline); draftPolyline = null; }
    lineDraft = null;
  }

  // ---------- map / node interactions ----------

  map.on("click", function (e) {
    if (mode === "point") {
      addNode(e.latlng.lat, e.latlng.lng);
    } else if (mode === "line" && lineDraft) {
      lineDraft.points.push([e.latlng.lat, e.latlng.lng]);
      redrawDraft();
    }
  });

  function onNodeClick(nodeId) {
    if (mode === "line") {
      if (!lineDraft) {
        lineDraft = { sourceId: nodeId, points: [[findNode(nodeId).lat, findNode(nodeId).lon]] };
        updateStatus("Trazando desde \"" + findNode(nodeId).name + "\"… click sobre la calle real, y termina en otro nodo.");
      } else if (nodeId === lineDraft.sourceId) {
        cancelLineDraft();
        updateStatus("Trazo cancelado. Click en un nodo para empezar de nuevo.");
      } else {
        lineDraft.points.push([findNode(nodeId).lat, findNode(nodeId).lon]);
        finishEdge(lineDraft.sourceId, nodeId, lineDraft.points);
        cancelLineDraft();
        updateStatus("Calle creada. Click en un nodo para trazar otra, o cambia de modo.");
      }
    } else if (mode === "delete") {
      deleteNode(nodeId);
    }
  }

  function onEdgeClick(edgeId) {
    if (mode === "delete") deleteEdge(edgeId);
  }

  function redrawDraft() {
    if (draftPolyline) map.removeLayer(draftPolyline);
    draftPolyline = L.polyline(lineDraft.points, { color: "#e5484d", weight: 3, dashArray: "6 6" }).addTo(map);
  }

  // ---------- CRUD ----------

  function addNode(lat, lon) {
    var defaultName = "Nodo " + nextNodeSeq;
    var name = window.prompt("Nombre del nodo (avenida / intersección):", defaultName);
    if (name === null) return; // cancelled
    var id = "m" + String(nextNodeSeq++).padStart(2, "0");
    var n = { id: id, name: name || defaultName, lat: lat, lon: lon };
    nodes.push(n);
    drawNodeMarker(n);
    undoStack.push({ type: "node", id: id });
    updateCounts();
    refreshNodeList();
    persist();
  }

  function finishEdge(sourceId, targetId, points) {
    var id = "e" + String(nextEdgeSeq++).padStart(2, "0");
    var edge = { id: id, source: sourceId, target: targetId, points: points.slice(), cost: polylineLength(points) };
    edges.push(edge);
    drawEdgeLayer(edge);
    undoStack.push({ type: "edge", id: id });
    updateCounts();
    persist();
  }

  function deleteNode(nodeId) {
    var attached = edges.filter(function (e) { return e.source === nodeId || e.target === nodeId; });
    if (attached.length && !window.confirm("Este nodo tiene " + attached.length + " calle(s) conectada(s). ¿Borrar todo?")) return;
    attached.forEach(function (e) { removeEdgeInternal(e.id); });
    removeNodeInternal(nodeId);
    persist();
  }

  function deleteEdge(edgeId) {
    removeEdgeInternal(edgeId);
    persist();
  }

  function removeNodeInternal(nodeId) {
    if (nodeMarkers[nodeId]) { map.removeLayer(nodeMarkers[nodeId]); delete nodeMarkers[nodeId]; }
    nodes = nodes.filter(function (n) { return n.id !== nodeId; });
    updateCounts();
    refreshNodeList();
  }

  function removeEdgeInternal(edgeId) {
    if (edgeLayers[edgeId]) { map.removeLayer(edgeLayers[edgeId]); delete edgeLayers[edgeId]; }
    edges = edges.filter(function (e) { return e.id !== edgeId; });
    updateCounts();
  }

  document.getElementById("btn-undo").addEventListener("click", function () {
    var last = undoStack.pop();
    if (!last) return;
    if (last.type === "node") {
      var attached = edges.filter(function (e) { return e.source === last.id || e.target === last.id; });
      attached.forEach(function (e) { removeEdgeInternal(e.id); });
      removeNodeInternal(last.id);
    } else {
      removeEdgeInternal(last.id);
    }
    persist();
  });

  document.getElementById("btn-clear-all").addEventListener("click", function () {
    if (!window.confirm("¿Borrar todos los nodos y calles?")) return;
    clearAllLayers();
    nodes = [];
    edges = [];
    undoStack = [];
    updateCounts();
    refreshNodeList();
    persist();
  });

  // ---------- save / load file ----------

  document.getElementById("btn-save").addEventListener("click", function () {
    var payload = JSON.stringify({ nodes: nodes, edges: edges }, null, 2);
    var blob = new Blob([payload], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "manual_graph.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  var fileInput = document.getElementById("file-input");
  document.getElementById("btn-load").addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        loadFromData(data);
        persist();
      } catch (e) {
        alert("Archivo inválido: " + e.message);
      }
    };
    reader.readAsText(file);
    fileInput.value = "";
  });

  // ---------- init ----------
  tryAutoRestore();
  updateCounts();
})();
