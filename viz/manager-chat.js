"use strict";

// ---------- bot de IA ----------

function openChat() { chatWidget.classList.add("open"); askInput.focus(); }
function closeChat() { chatWidget.classList.remove("open"); }
chatToggleBtn.addEventListener("click", function () {
  chatWidget.classList.contains("open") ? closeChat() : openChat();
});
chatMinimizeBtn.addEventListener("click", closeChat);

function addChatMessage(text, extraClass) {
  var div = document.createElement("div");
  div.className = "chat-msg " + extraClass;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function setChatBotMessage(el, text, kind) {
  el.textContent = text;
  el.className = "chat-msg chat-msg-bot" + (kind === "error" ? " chat-msg-error" : kind === "status" ? " chat-msg-status" : "");
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
    currentRouteDraft = route2;
    assignRoute(dd.chofer_id); // reusa el flujo real: persiste, arranca simulación, log, toast
    var orderNames = route2.stops.map(function (id) { return nodesById[id].name; });
    var resumen2 = "Envío asignado a " + dd.chofer_nombre + ". Orden: " + orderNames.join(" → ") + ". " + fmtMeters(route2.distance_m) + ", " + fmtDuration(route2.time_s) + ".";
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

