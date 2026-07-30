"use strict";

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
var SIM_SPEED_FACTOR = 1; // 1-20, controlado por el slider "Velocidad simulación"; 1 = tiempo real
var UNLOAD_WAIT_S = 20;    // espera fija de "descarga" al llegar, en segundos a 1x (se escala por SIM_SPEED_FACTOR)
var WAREHOUSE_WAIT_S = 15; // espera fija "recogiendo pedido" en el almacén, en segundos a 1x (se escala por SIM_SPEED_FACTOR)
var TOAST_AUTO_DISMISS_MS = 6000;

// tipos de vehículo: orden de menor a mayor capacidad, usado para saber si un chofer puede
// llevar un encargo que la IA clasificó con un vehículo mínimo (VEHICLE_RANK[d.vehicle_type]
// >= VEHICLE_RANK[minimo])
var VEHICLE_ICONS = { moto: "🏍️", auto: "🚗", noa: "🚐", camion: "🚚" };
var VEHICLE_LABELS = { moto: "Moto", auto: "Auto", noa: "Furgoneta", camion: "Camión" };
var VEHICLE_RANK = { moto: 0, auto: 1, noa: 2, camion: 3 };

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

