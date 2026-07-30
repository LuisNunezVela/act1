"use strict";

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
    label.appendChild(document.createTextNode(" " + d.name + " — " + (d.status === "en_ruta" ? "En ruta" : "Libre")));
    row.appendChild(label);

    var phoneBtn = document.createElement("button");
    phoneBtn.className = "btn-secondary";
    phoneBtn.textContent = "📱 Ver celular";
    phoneBtn.style.marginBottom = "0";
    phoneBtn.addEventListener("click", function () { window.open("driver.html?driver=" + d.id, "_blank"); });
    row.appendChild(phoneBtn);

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
    driverWanderAnchorSeen[r.data.id] = r.data.idle_since;
    startDriverWander(r.data);
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
});

function deleteDriver(id) {
  api("DELETE", "/manager/drivers/" + id).then(function (r) {
    if (!r.ok) { alert(r.data.error || "No se pudo eliminar el chofer."); return; }
    drivers = drivers.filter(function (d) { return d.id !== id; });
    clearDriverWander(id);
    delete driverWanderAnchorSeen[id];
    delete driverWanderState[id];
    refreshDriverList();
  }).catch(function () { alert("No se pudo conectar con el backend (¿está corriendo en :5000?)."); });
}

// ---------- paseo idle: choferes sin pedido caminan al azar por el grafo ----------
//
// Igual que la simulación de viajes, esto es puramente client-side y determinista:
// la posición de un chofer idle en cualquier instante se deriva de (last_node_id,
// idle_since) más un RNG sembrado con esos dos valores, así que cualquier pestaña que
// haga el mismo cálculo llega a la misma posición sin que el backend empuje updates.

var driverWanderTimers = {};      // setInterval por chofer, keyed por driver.id
var driverWanderState = {};       // {rng, hops, hopBounds, cumTime, currentNode, prevNode, anchor, idleSince}
var driverWanderAnchorSeen = {};  // {driverId: idle_since visto la última vez}, evita reiniciar el loop en cada poll

function xmur3(str) {
  var h = 1779033703 ^ str.length;
  for (var i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed) {
  var a = seed;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedStr) { return mulberry32(xmur3(seedStr)()); }

var WANDER_HOP_GUARD = 2000; // tope de hops generados por llamada, por si un nodo quedara aislado

// Extiende (memoizado por chofer) una caminata aleatoria de hops a partir de last_node_id
// hasta cubrir uptoSeconds de duración simulada; reusa buildHops/edgeTimeSeconds/pointsBetween
// para que la geometría/tiempo de cada hop sea idéntico al de un viaje real.
function ensureWanderHops(driver, uptoSeconds) {
  var st = driverWanderState[driver.id];
  if (!st || st.anchor !== driver.last_node_id || st.idleSince !== driver.idle_since) {
    st = {
      rng: makeRng(driver.id + "|" + driver.idle_since),
      hops: [], hopBounds: [], cumTime: 0,
      currentNode: driver.last_node_id, prevNode: null,
      anchor: driver.last_node_id, idleSince: driver.idle_since,
    };
    driverWanderState[driver.id] = st;
  }
  var guard = 0;
  while (st.cumTime < uptoSeconds && guard++ < WANDER_HOP_GUARD) {
    var options = (adjacency[st.currentNode] || []).filter(function (a) { return !isBlocked(a.edge); });
    if (options.length === 0) break; // nodo aislado o todo bloqueado: se queda quieto ahí
    var nonBack = st.prevNode ? options.filter(function (a) { return a.to !== st.prevNode; }) : options;
    var pool = nonBack.length > 0 ? nonBack : options;
    var pick = pool[Math.floor(st.rng() * pool.length) % pool.length];
    var hop = {
      from: st.currentNode, to: pick.to, points: pointsBetween(st.currentNode, pick.to),
      distance_m: pick.edge.weight, time_s: edgeTimeSeconds(pick.edge, false),
    };
    var start = st.cumTime;
    st.cumTime += hop.time_s || 0.001; // evita loop infinito si algún edge tuviera peso 0
    st.hops.push(hop);
    st.hopBounds.push({ start: start, end: st.cumTime, hop: hop });
    st.prevNode = st.currentNode;
    st.currentNode = pick.to;
  }
  return st;
}

function wanderPositionNow(driver) {
  if (!driver.last_node_id || !driver.idle_since) return null;
  var elapsed = (Date.now() - new Date(driver.idle_since).getTime()) / 1000;
  if (elapsed < 0) elapsed = 0;
  var st = ensureWanderHops(driver, elapsed);
  if (st.hops.length === 0) {
    var n = nodesById[driver.last_node_id];
    return [n.lat, n.lon];
  }
  return positionAtElapsed(st.hops, st.hopBounds, elapsed);
}

// posición EXACTA del paseo en curso (no el nodo más cercano): si el chofer está a mitad de
// un hop, devuelve el punto interpolado + ese hop (from/to/cuántos metros ya recorrió en él),
// para que el tramo de recogida pueda arrancar justo desde ahí en vez de "teletransportarlo"
// al nodo más próximo. anchorNode es el nodo desde el que hay que seguir por Dijkstra hacia
// el almacén (el destino del hop en curso, o el propio last_node_id si nunca se movió).
function currentWanderPosition(driver) {
  if (!driver.last_node_id || !driver.idle_since) {
    return { point: null, hopFrom: null, hopTo: null, distIntoHop_m: 0, anchorNode: driver.last_node_id };
  }
  var elapsed = (Date.now() - new Date(driver.idle_since).getTime()) / 1000;
  if (elapsed < 0) elapsed = 0;
  var st = ensureWanderHops(driver, elapsed);
  if (st.hops.length === 0) {
    var n = nodesById[driver.last_node_id];
    return { point: [n.lat, n.lon], hopFrom: null, hopTo: null, distIntoHop_m: 0, anchorNode: driver.last_node_id };
  }
  var hb = st.hopBounds.filter(function (b) { return elapsed >= b.start && elapsed < b.end; })[0];
  if (!hb) {
    var lastHop = st.hops[st.hops.length - 1];
    return {
      point: lastHop.points[lastHop.points.length - 1],
      hopFrom: null, hopTo: null, distIntoHop_m: 0, anchorNode: lastHop.to,
    };
  }
  var t = hb.hop.time_s === 0 ? 0 : (elapsed - hb.start) / hb.hop.time_s;
  var distIntoHop = t * hb.hop.distance_m;
  return {
    point: pointAtDistanceWithinHop(hb.hop.points, distIntoHop),
    hopFrom: hb.hop.from, hopTo: hb.hop.to, distIntoHop_m: distIntoHop, anchorNode: hb.hop.to,
  };
}

function clearDriverWander(driverId) {
  if (driverWanderTimers[driverId]) { clearInterval(driverWanderTimers[driverId]); delete driverWanderTimers[driverId]; }
}

function startDriverWander(driver) {
  clearDriverWander(driver.id);
  if (!driver.last_node_id) {
    if (driverMarkers[driver.id]) { map.removeLayer(driverMarkers[driver.id]); delete driverMarkers[driver.id]; }
    return;
  }

  function render() {
    var pos = wanderPositionNow(driver);
    if (!pos) return;
    if (!driverMarkers[driver.id]) {
      var marker = L.marker(pos, { icon: L.divIcon({ className: "driver-marker", html: "🚚", iconSize: null }) }).addTo(map);
      marker.bindTooltip(driver.name + " (libre)", { direction: "top", offset: [0, -10] });
      marker.on("click", function () { openDriverDetail(driver.id); });
      driverMarkers[driver.id] = marker;
    } else {
      driverMarkers[driver.id].setLatLng(pos);
    }
  }
  render();
  driverWanderTimers[driver.id] = setInterval(render, SIM_TICK_MS);
}

