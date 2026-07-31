"use strict";

// ---------- bot de IA ----------

function openChat() { chatWidget.classList.add("open"); askInput.focus(); }
function closeChat() { chatWidget.classList.remove("open"); }
chatToggleBtn.addEventListener("click", function () {
  chatWidget.classList.contains("open") ? closeChat() : openChat();
});
chatMinimizeBtn.addEventListener("click", closeChat);

// ---------- historial persistente (localStorage, así sobrevive a cambiar de pestaña o
// recargar la página — antes se perdía porque solo vivía en memoria del script) ----------

var CHAT_HISTORY_KEY = "easyroute_chat_history_v1";

function loadStoredChatHistory() {
  try {
    var raw = localStorage.getItem(CHAT_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveStoredChatHistory() {
  try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(chatHistory)); } catch (e) { /* localStorage lleno o deshabilitado: no es crítico, solo no persiste */ }
}

var chatHistory = loadStoredChatHistory();

function clearChatHistory() {
  chatHistory = [];
  saveStoredChatHistory();
  chatMessages.innerHTML = "";
}

chatClearBtn.addEventListener("click", clearChatHistory);

function addChatMessage(text, extraClass, skipPersist) {
  var div = document.createElement("div");
  div.className = "chat-msg " + extraClass;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  // los mensajes de estado transitorio ("Pensando…") no se guardan — se reemplazan en el
  // momento por la respuesta final vía setChatBotMessage, que sí persiste
  if (!skipPersist && extraClass.indexOf("chat-msg-status") === -1) {
    chatHistory.push({ text: text, cls: extraClass });
    saveStoredChatHistory();
  }
  return div;
}

function setChatBotMessage(el, text, kind) {
  var extraClass = "chat-msg-bot" + (kind === "error" ? " chat-msg-error" : kind === "status" ? " chat-msg-status" : "");
  el.textContent = text;
  el.className = "chat-msg " + extraClass;
  chatMessages.scrollTop = chatMessages.scrollHeight;
  if (kind !== "status") {
    chatHistory.push({ text: text, cls: extraClass });
    saveStoredChatHistory();
  }
}

// repone el historial guardado al abrir/recargar la página (con skipPersist para no
// volver a guardar lo que ya estaba guardado)
chatHistory.forEach(function (m) { addChatMessage(m.text, m.cls, true); });

// tras un despacho hecho por chat/voz (sin la foto+IA del panel manual) se ofrece
// agregar una foto del encargo directamente en la burbuja del chat, para que también
// quede guardada en el Historial del viaje
function addChatPhotoPrompt(tripId) {
  var div = document.createElement("div");
  div.className = "chat-msg chat-msg-bot chat-msg-photo-prompt";

  var label = document.createElement("div");
  label.textContent = "📦 ¿Le agregamos una foto del encargo a este viaje?";
  div.appendChild(label);

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-secondary btn-block chat-photo-btn";
  btn.textContent = "📷 Subir foto";
  div.appendChild(btn);

  var fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.style.display = "none";
  div.appendChild(fileInput);

  btn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return;
    btn.disabled = true;
    btn.textContent = "Subiendo…";
    var formData = new FormData();
    formData.append("photo", file);
    fetch(BACKEND + "/manager/trips/" + tripId + "/photo", { method: "POST", body: formData })
      .then(function (res) { label.textContent = res.ok ? "📦 Foto agregada al viaje ✅" : "📦 No se pudo subir la foto."; })
      .catch(function () { label.textContent = "📦 No se pudo conectar con el backend para subir la foto."; })
      .finally(function () { btn.remove(); fileInput.remove(); });
  });

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function askManagerBot() {
  var query = askInput.value.trim();
  if (!query) return;

  addChatMessage(query, "chat-msg-user");
  askInput.value = "";
  btnAsk.disabled = true;
  var botMsg = addChatMessage("Pensando…", "chat-msg-bot chat-msg-status");

  api("POST", "/manager/chat/parse", { query: query }).then(function (parsed) {
    if (!parsed.ok) { setChatBotMessage(botMsg, parsed.data.error || "No entendí el pedido.", "error"); return null; }

    if (parsed.data.intent === "otro") {
      setChatBotMessage(botMsg, "Por ahora puedo decirte tiempos de viaje, el clima de un lugar, o enviar choferes a hacer una entrega. ¿Podrías reformular tu pedido?", "answer");
      return null;
    }

    if (parsed.data.intent === "clima" || parsed.data.intent === "aclaracion") {
      setChatBotMessage(botMsg, parsed.data.respuesta, "answer");
      return null;
    }

    if (parsed.data.intent === "consulta_tiempo") {
      var d = parsed.data;
      var route = computeRoute(d.origen_id, [d.destino_id], peakToggle.checked);
      if (!route) { setChatBotMessage(botMsg, "No hay camino posible entre esos nodos (revisa las calles bloqueadas).", "error"); return null; }
      var resumen = "Desde " + d.origen_nombre + " hasta " + d.destino_nombre + ": " + fmtMeters(route.distance_m) + ", " + fmtDuration(route.time_s) + ".";
      return api("POST", "/manager/chat/confirm", { query: query, resumen: resumen });
    }

    // despacho
    var dd = parsed.data;
    var route2 = computeRoute(dd.warehouse_id, dd.paradas_ids, peakToggle.checked);
    if (!route2) { setChatBotMessage(botMsg, "No hay camino posible hacia esas paradas (revisa las calles bloqueadas).", "error"); return null; }

    var driverId, driverLabel;
    if (dd.chofer_id) {
      driverId = dd.chofer_id;
      driverLabel = dd.chofer_nombre;
    } else {
      // el backend no conoce la posición en vivo de los choferes (es puramente
      // client-side) — el frontend elige el libre del tipo de vehículo pedido más
      // cercano al almacén, igual que ya hace applyPackageAnalysis con la foto de IA
      var warehousePoint = [nodesById[dd.warehouse_id].lat, nodesById[dd.warehouse_id].lon];
      var candidates = drivers.filter(function (d) { return d.status === "idle" && d.vehicle_type === dd.vehiculo; });
      if (candidates.length === 0) {
        setChatBotMessage(botMsg, "No hay choferes libres en " + (VEHICLE_LABELS[dd.vehiculo] || dd.vehiculo) + " ahora mismo.", "error");
        return null;
      }
      var nearest = rankIdleDriversByDistance(candidates, warehousePoint)[0];
      driverId = nearest.driver.id;
      driverLabel = nearest.driver.name;
    }

    currentRouteDraft = route2;

    // dd.destinatarios viene alineado a dd.paradas_ids (orden en que el usuario los
    // mencionó); se remapea por node_id sobre route2.stops (orden final, puede haberse
    // reordenado al optimizar la ruta) para no desalinear nombres con paradas.
    var recipientByNode = {};
    dd.paradas_ids.forEach(function (stopId, i) {
      var d = dd.destinatarios[i] || {};
      recipientByNode[stopId] = { name: d.nombre || "", phone: d.telefono || "" };
    });
    var recipients = route2.stops.map(function (stopId) {
      var r = recipientByNode[stopId] || { name: "", phone: "" };
      return { node_id: stopId, name: r.name, phone: r.phone };
    });

    assignRoute(driverId, recipients, function (data) {
      // reusa el flujo real: persiste, arranca simulación, log, toast — y como este
      // despacho vino de voz/texto (sin pasar por el panel de foto+IA), se ofrece
      // agregar la foto directamente en el chat
      if (data.trip_id) addChatPhotoPrompt(data.trip_id);
    });

    var orderNames = route2.stops.map(function (id) { return nodesById[id].name; });
    var recipientNames = recipients.filter(function (r) { return r.name; }).map(function (r) { return r.name; });
    var resumen2 = "Envío asignado a " + driverLabel + ". Orden: " + orderNames.join(" → ") + ". " +
      fmtMeters(route2.distance_m) + ", " + fmtDuration(route2.time_s) + "." +
      (recipientNames.length ? " Destinatarios: " + recipientNames.join(", ") + "." : "");
    return api("POST", "/manager/chat/confirm", { query: query, resumen: resumen2 });
  }).then(function (confirmResult) {
    if (!confirmResult) return;
    if (!confirmResult.ok) { setChatBotMessage(botMsg, confirmResult.data.error || "No se pudo generar la respuesta.", "error"); return; }
    setChatBotMessage(botMsg, confirmResult.data.respuesta, "answer");
  }).catch(function () {
    setChatBotMessage(botMsg, "No se pudo conectar con el backend (¿está corriendo en :5000?).", "error");
  }).finally(function () {
    btnAsk.disabled = false;
  });
}

btnAsk.addEventListener("click", askManagerBot);
askInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") askManagerBot();
});

// ---------- dictado por voz (Web Speech API del navegador, sin backend) ----------

var SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognitionCtor) {
  btnMic.disabled = true;
  btnMic.title = "Reconocimiento de voz no disponible en este navegador (usa Chrome o Edge)";
} else {
  var recognition = new SpeechRecognitionCtor();
  recognition.lang = "es-419";
  // continuous: true evita que corte apenas hay una pausa breve al hablar — sigue
  // grabando (acumulando cada frase que se va finalizando) hasta que el usuario aprieta
  // "detener" explícitamente; recién ahí se arma el texto completo y se envía.
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  var listening = false;
  var finalTranscriptParts = [];

  function setMicIdle() {
    listening = false;
    btnMic.classList.remove("listening");
    btnMic.textContent = "🎤";
    btnMic.title = "Hablar";
  }

  recognition.addEventListener("result", function (e) {
    for (var i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalTranscriptParts.push(e.results[i][0].transcript);
    }
  });

  // "end" se dispara siempre al terminar (tanto al detener manualmente como tras un
  // error), ya con cualquier resultado pendiente ya volcado por "result" — es el único
  // lugar donde armamos el texto final y disparamos el envío, para no enviar a mitad de
  // frase ni duplicar el envío entre "result" y "error".
  recognition.addEventListener("end", function () {
    setMicIdle();
    var transcript = finalTranscriptParts.join(" ").trim();
    finalTranscriptParts = [];
    if (transcript) {
      askInput.value = transcript;
      askManagerBot(); // auto-envío: el pedido se interpreta y (si es un despacho) se asigna solo
    }
  });
  recognition.addEventListener("error", function (e) {
    if (e.error === "aborted" || e.error === "no-speech") return; // detenido a propósito o silencio, no son errores reales
    addChatMessage("No pude escucharte (" + e.error + "). ¿Podés repetir?", "chat-msg-bot chat-msg-error");
  });

  btnMic.addEventListener("click", function () {
    if (listening) { recognition.stop(); return; }
    openChat();
    finalTranscriptParts = [];
    listening = true;
    btnMic.classList.add("listening");
    btnMic.textContent = "⏹";
    btnMic.title = "Detener grabación";
    recognition.start();
  });
}

