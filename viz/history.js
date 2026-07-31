(function () {
  "use strict";

  if (typeof GRAPH_DATA === "undefined" || !GRAPH_DATA.nodes || GRAPH_DATA.nodes.length === 0) {
    document.getElementById("history-page").innerHTML =
      '<h1>Historial</h1><p class="subtitle">Todavía no hay un grafo generado.</p>' +
      '<p class="hint">Genera el grafo primero desde <code>editor.html</code> y el notebook.</p>';
    return;
  }

  var BACKEND = "http://127.0.0.1:5000";

  var VEHICLE_ICONS = { moto: "🏍️", auto: "🚗", noa: "🚐", camion: "🚚" };

  function api(method, path) {
    return fetch(BACKEND + path).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    });
  }

  var nodesById = {};
  GRAPH_DATA.nodes.forEach(function (n) { nodesById[n.id] = n; });

  // ---------- proyección lat/lon -> SVG (sin depender de Leaflet: solo un dibujo esquemático) ----------

  // los límites y el proyector se calculan por-llamada (no una sola vez global) porque un
  // viaje viejo puede traer su propia instantánea histórica del grafo (otros nodos, otra
  // extensión geográfica) en vez del grafo actual — ver opts.graphNodes en renderGraphSvg.
  function computeBounds(nodes) {
    var lats = nodes.map(function (n) { return n.lat; });
    var lons = nodes.map(function (n) { return n.lon; });
    return {
      minLat: Math.min.apply(null, lats), maxLat: Math.max.apply(null, lats),
      minLon: Math.min.apply(null, lons), maxLon: Math.max.apply(null, lons),
    };
  }

  // factor de corrección de aspecto: 1° de longitud pesa menos que 1° de latitud en distancia
  // real, salvo en el ecuador — se corrige con el coseno de la latitud media del grafo para
  // que el dibujo no salga estirado horizontalmente
  function makeProjector(bounds, w, h, pad) {
    var midLatCos = Math.cos(((bounds.minLat + bounds.maxLat) / 2) * Math.PI / 180);
    var lonRange = (bounds.maxLon - bounds.minLon) || 1;
    var latRange = (bounds.maxLat - bounds.minLat) || 1;
    var wUnits = lonRange * midLatCos, hUnits = latRange;
    var scale = Math.min((w - 2 * pad) / wUnits, (h - 2 * pad) / hUnits);
    var offsetX = (w - wUnits * scale) / 2;
    var offsetY = (h - hUnits * scale) / 2;
    return function (lat, lon) {
      var x = offsetX + (lon - bounds.minLon) * midLatCos * scale;
      var y = offsetY + (bounds.maxLat - lat) * scale; // lat mayor = arriba
      return [x, y];
    };
  }

  var SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // Dibuja el grafo completo en gris tenue; opcionalmente resalta un camino en verde (con
  // marcador verde en el origen y rojo en el destino, como bugs/report.png) y/o colorea cada
  // nodo según opts.nodeColors (mapa de calor). Todo client-side, sin backend ni Leaflet.
  // Por defecto dibuja el grafo ACTUAL (GRAPH_DATA); pasando opts.graphNodes/opts.graphEdges
  // (la instantánea histórica de un viaje viejo, ver loadTrips) dibuja esa versión en cambio.
  function renderGraphSvg(opts) {
    opts = opts || {};
    var graphNodes = opts.graphNodes || GRAPH_DATA.nodes;
    var graphEdges = opts.graphEdges || GRAPH_DATA.edges;
    var byId = opts.graphNodes ? {} : nodesById;
    if (opts.graphNodes) graphNodes.forEach(function (n) { byId[n.id] = n; });

    var w = opts.width || 260, h = opts.height || 180;
    var project = makeProjector(computeBounds(graphNodes), w, h, opts.pad || 14);
    var svg = svgEl("svg", { viewBox: "0 0 " + w + " " + h, width: w, height: h, class: "graph-svg" });

    graphEdges.forEach(function (e) {
      var a = byId[e.source], b = byId[e.target];
      if (!a || !b) return;
      var pa = project(a.lat, a.lon), pb = project(b.lat, b.lon);
      svg.appendChild(svgEl("line", { x1: pa[0], y1: pa[1], x2: pb[0], y2: pb[1], class: "graph-edge" }));
    });

    if (opts.highlightPath && opts.highlightPath.length > 1) {
      var pts = opts.highlightPath.map(function (id) {
        var n = byId[id];
        return n ? project(n.lat, n.lon) : null;
      });
      if (pts.every(function (p) { return p; })) {
        svg.appendChild(svgEl("polyline", {
          points: pts.map(function (p) { return p[0] + "," + p[1]; }).join(" "),
          class: "graph-highlight-path",
        }));
      }
    }

    graphNodes.forEach(function (n) {
      var p = project(n.lat, n.lon);
      var color = (opts.nodeColors && opts.nodeColors[n.id]) || "#c3c2b7";
      var r = (opts.nodeRadii && opts.nodeRadii[n.id]) || (opts.smallNodes ? 2 : 2.6);
      var circle = svgEl("circle", { cx: p[0], cy: p[1], r: r, fill: color });
      if (opts.nodeTitle) {
        var title = document.createElementNS(SVG_NS, "title");
        title.textContent = opts.nodeTitle(n);
        circle.appendChild(title);
      }
      svg.appendChild(circle);
    });

    function marker(nodeId, extraClass) {
      var n = byId[nodeId];
      if (!n) return;
      var p = project(n.lat, n.lon);
      svg.appendChild(svgEl("circle", { cx: p[0], cy: p[1], r: 4.5, class: "graph-marker " + extraClass }));
    }
    if (opts.originNodeId) marker(opts.originNodeId, "graph-marker-origin");
    if (opts.destNodeId) marker(opts.destNodeId, "graph-marker-dest");

    return svg;
  }

  // ---------- pestañas ----------

  var tabs = document.querySelectorAll(".history-tab");
  var panels = { viajes: document.getElementById("tab-viajes"), reportes: document.getElementById("tab-reportes") };
  tabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabs.forEach(function (b) { b.classList.toggle("active", b === btn); });
      var tab = btn.dataset.tab;
      panels.viajes.style.display = tab === "viajes" ? "block" : "none";
      panels.reportes.style.display = tab === "reportes" ? "block" : "none";
      if (tab === "reportes") loadHeatmap();
    });
  });

  // ---------- pestaña Viajes ----------

  var tripDateInput = document.getElementById("trip-date-input");
  var tripTodayBtn = document.getElementById("trip-today-btn");
  var tripList = document.getElementById("trip-list");

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function localDateStr(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function fmtTime(iso) { var d = new Date(iso); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }
  function fmtMeters(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }
  function fmtDuration(s) {
    var totalMin = Math.round(s / 60);
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    return h > 0 ? (h + "h " + m + "min") : (m + " min");
  }

  // Rango [00:00, 24:00) del día local `dateStr`, en ISO UTC (mismo patrón que el registro
  // de eventos del manager) para que el backend filtre con una simple comparación de strings.
  function dayRangeUtcIso(dateStr) {
    var parts = dateStr.split("-").map(Number);
    var start = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    var end = new Date(parts[0], parts[1] - 1, parts[2] + 1, 0, 0, 0, 0);
    return { from: start.toISOString(), to: end.toISOString() };
  }

  var photoLightbox = document.getElementById("photo-lightbox");
  var photoLightboxImg = document.getElementById("photo-lightbox-img");
  photoLightbox.addEventListener("click", function () { photoLightbox.style.display = "none"; });

  function tripStopNames(trip, byId) {
    var names = trip.stops.map(function (id) { return byId[id] ? byId[id].name : id; });
    var origin = byId[trip.node_path[0]];
    return (origin ? origin.name : trip.node_path[0]) + " → " + names.join(" → ");
  }

  function renderTripCard(trip) {
    var card = document.createElement("div");
    card.className = "trip-card";

    // si el grafo actual ya no coincide con el de este viaje, se usa la instantánea
    // histórica guardada al momento del envío (si existe) tanto para el mini-mapa como
    // para los nombres de nodo — así se ve el mapa/las paradas tal como estaban entonces,
    // en vez de "mapa no disponible" o ids crudos sin nombre.
    var tripNodesById = nodesById;
    if (!trip.graph_matches && trip.historical_graph) {
      tripNodesById = {};
      trip.historical_graph.nodes.forEach(function (n) { tripNodesById[n.id] = n; });
    }

    var mapWrap = document.createElement("div");
    mapWrap.className = "trip-card-map";
    if (trip.graph_matches) {
      mapWrap.appendChild(renderGraphSvg({
        width: 260, height: 170,
        highlightPath: trip.node_path,
        originNodeId: trip.node_path[0],
        destNodeId: trip.node_path[trip.node_path.length - 1],
      }));
    } else if (trip.historical_graph) {
      mapWrap.appendChild(renderGraphSvg({
        width: 260, height: 170,
        graphNodes: trip.historical_graph.nodes,
        graphEdges: trip.historical_graph.edges,
        highlightPath: trip.node_path,
        originNodeId: trip.node_path[0],
        destNodeId: trip.node_path[trip.node_path.length - 1],
      }));
      var oldNotice = document.createElement("div");
      oldNotice.className = "trip-card-map-old-notice";
      oldNotice.textContent = "Mapa vigente al momento del envío (el grafo cambió después)";
      mapWrap.appendChild(oldNotice);
    } else {
      mapWrap.className += " trip-card-map-unavailable";
      mapWrap.textContent = "Mapa no disponible: el grafo cambió desde este viaje.";
    }
    card.appendChild(mapWrap);

    var body = document.createElement("div");
    body.className = "trip-card-body";

    var header = document.createElement("div");
    header.className = "trip-card-header";
    var driverSpan = document.createElement("span");
    driverSpan.className = "trip-card-driver";
    driverSpan.textContent = (VEHICLE_ICONS[trip.vehicle_type] || "🚗") + " " + trip.driver_name;
    header.appendChild(driverSpan);
    var badge = document.createElement("span");
    badge.className = "trip-status-badge " + (trip.completed_at ? "done" : "in-progress");
    badge.textContent = trip.completed_at ? "Completado" : "Viaje en curso";
    header.appendChild(badge);
    body.appendChild(header);

    var route = document.createElement("div");
    route.className = "trip-card-route";
    route.textContent = tripStopNames(trip, tripNodesById);
    body.appendChild(route);

    var stats = document.createElement("div");
    stats.className = "trip-card-stats";
    var statsText = fmtMeters(trip.distance_m) + " · " + fmtDuration(trip.time_s) + " planeado · asignado " + fmtTime(trip.assigned_at);
    if (trip.completed_at) statsText += " · completado " + fmtTime(trip.completed_at);
    stats.textContent = statsText;
    body.appendChild(stats);

    (trip.recipients || []).filter(function (r) { return r.name || r.phone; }).forEach(function (r) {
      var node = tripNodesById[r.node_id];
      var recipient = document.createElement("div");
      recipient.className = "trip-card-recipient";
      recipient.textContent = "📇 " + (node ? node.name + ": " : "") + (r.name || "Destinatario sin nombre") +
        (r.phone ? " · " + r.phone : "");
      body.appendChild(recipient);
    });

    if (trip.photo_url) {
      var photo = document.createElement("img");
      photo.className = "trip-card-photo";
      photo.src = BACKEND + trip.photo_url;
      photo.alt = "Foto del encargo";
      photo.title = "Click para ampliar";
      photo.addEventListener("click", function () {
        photoLightboxImg.src = BACKEND + trip.photo_url;
        photoLightbox.style.display = "flex";
      });
      body.appendChild(photo);
    }

    card.appendChild(body);
    return card;
  }

  function loadTrips(dateStr) {
    var range = dayRangeUtcIso(dateStr);
    tripList.innerHTML = "";
    api("GET", "/manager/trips?from=" + encodeURIComponent(range.from) + "&to=" + encodeURIComponent(range.to))
      .then(function (r) {
        if (!r.ok) return;
        if (r.data.length === 0) {
          tripList.innerHTML = '<p class="hint">Sin viajes ese día.</p>';
          return;
        }
        r.data.forEach(function (trip) { tripList.appendChild(renderTripCard(trip)); });
      })
      .catch(function () {
        tripList.innerHTML = '<p class="hint">No se pudo conectar con el backend (¿está corriendo en :5000?).</p>';
      });
  }

  var todayStr = localDateStr(new Date());
  tripDateInput.value = todayStr;
  loadTrips(todayStr);

  tripDateInput.addEventListener("change", function () {
    if (tripDateInput.value) loadTrips(tripDateInput.value);
  });
  tripTodayBtn.addEventListener("click", function () {
    tripDateInput.value = todayStr;
    loadTrips(todayStr);
  });

  // ---------- pestaña Reportes: mapa de calor de nodos más pedidos ----------

  // rampa secuencial de un solo color (teal de la marca), tenue -> saturado, siguiendo la
  // guía de la skill de dataviz para magnitud (nunca arcoíris)
  var HEAT_LIGHT = [214, 244, 240];
  var HEAT_DARK = [4, 71, 64];
  function heatColor(t) {
    var rgb = HEAT_LIGHT.map(function (c0, i) { return Math.round(c0 + (HEAT_DARK[i] - c0) * t); });
    return "rgb(" + rgb.join(",") + ")";
  }

  var heatmapWrap = document.getElementById("heatmap-wrap");
  var heatmapLegendTicks = document.getElementById("heatmap-legend-ticks");
  var heatmapLoaded = false;

  // Marca el tope real (nodo con más pedidos) y unos pasos intermedios sobre la barra de
  // degradé, para poder leer el rango en números y no solo por intensidad de color.
  function renderHeatmapLegend(maxCount) {
    heatmapLegendTicks.innerHTML = "";
    if (maxCount <= 0) {
      var empty = document.createElement("span");
      empty.className = "heatmap-legend-tick";
      empty.style.left = "0%";
      empty.textContent = "Sin envíos registrados aún";
      heatmapLegendTicks.appendChild(empty);
      return;
    }
    var steps = Math.min(4, maxCount);
    var values = [];
    for (var i = 0; i <= steps; i++) values.push(Math.round((maxCount * i) / steps));
    values = values.filter(function (v, i) { return i === 0 || v !== values[i - 1]; });

    values.forEach(function (v) {
      var pct = (v / maxCount) * 100;
      var tick = document.createElement("span");
      tick.className = "heatmap-legend-tick";
      tick.style.left = pct + "%";
      tick.style.transform = pct <= 0 ? "translateX(0)" : pct >= 100 ? "translateX(-100%)" : "translateX(-50%)";
      tick.textContent = v;
      heatmapLegendTicks.appendChild(tick);
    });
  }

  function loadHeatmap() {
    if (heatmapLoaded) return;
    heatmapLoaded = true;
    api("GET", "/manager/node-selection-counts").then(function (r) {
      if (!r.ok) return;
      var counts = r.data;
      var maxCount = 0;
      Object.keys(counts).forEach(function (id) { if (counts[id] > maxCount) maxCount = counts[id]; });

      var nodeColors = {}, nodeRadii = {};
      GRAPH_DATA.nodes.forEach(function (n) {
        var c = counts[n.id] || 0;
        var t = maxCount > 0 ? c / maxCount : 0;
        nodeColors[n.id] = c > 0 ? heatColor(t) : "#e1e0d9";
        nodeRadii[n.id] = c > 0 ? 3 + t * 5 : 2.2;
      });

      heatmapWrap.innerHTML = "";
      heatmapWrap.appendChild(renderGraphSvg({
        width: 900, height: 620, pad: 24,
        nodeColors: nodeColors, nodeRadii: nodeRadii,
        nodeTitle: function (n) { return n.name + " — " + (counts[n.id] || 0) + " envíos"; },
      }));
      renderHeatmapLegend(maxCount);
    });
  }
})();
