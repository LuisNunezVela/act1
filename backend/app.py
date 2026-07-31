"""Backend LangChain para EasyRoute.

Backend del Gestor de reparto (viz/manager.html): chat en lenguaje natural para
despachar choferes/consultar tiempos/clima, análisis de fotos de encargos con
Gemini (visión), y persistencia (SQLite) de almacén, choferes, rutas, tráfico,
vías bloqueadas, historial de viajes y el registro de eventos.
"""
import base64
import hashlib
import re
import json
import sqlite3
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from pydantic import BaseModel, Field
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

load_dotenv()

DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "graph_export.json"


def load_number_to_id(path: Path) -> dict[int, str]:
    graph = json.loads(path.read_text(encoding="utf-8"))
    mapping = {}
    for node in graph["nodes"]:
        match = re.search(r"\d+", node["name"])
        if match:
            mapping[int(match.group())] = node["id"]
    return mapping


NUMBER_TO_ID = load_number_to_id(DATA_PATH)
NODES_BY_ID = {n["id"]: n for n in json.loads(DATA_PATH.read_text(encoding="utf-8"))["nodes"]}

EDGE_PAIRS = set()
for _edge in json.loads(DATA_PATH.read_text(encoding="utf-8"))["edges"]:
    EDGE_PAIRS.add(frozenset({_edge["source"], _edge["target"]}))

# huella del grafo actual: si el editor+notebook regeneran graph_export.json con otros
# nodos/aristas, este hash cambia y el contador de nodos más pedidos (Historial > Reportes)
# se reinicia la próxima vez que arranque el backend (ver init_db)
GRAPH_FINGERPRINT = hashlib.sha256(DATA_PATH.read_bytes()).hexdigest()

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "manager_state.db"

PHOTOS_DIR = Path(__file__).resolve().parent.parent / "data" / "driver_photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
PACKAGE_PHOTOS_DIR = Path(__file__).resolve().parent.parent / "data" / "package_photos"
PACKAGE_PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_PHOTO_EXT = {"png", "jpg", "jpeg", "gif", "webp"}


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS warehouse (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            node_id TEXT
        );
        CREATE TABLE IF NOT EXISTS drivers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'idle',
            route_json TEXT,
            assigned_at TEXT
        );
        CREATE TABLE IF NOT EXISTS node_traffic (
            node_id TEXT PRIMARY KEY,
            level TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS blocked_edges (
            node_a TEXT NOT NULL,
            node_b TEXT NOT NULL,
            reason TEXT,
            blocked_at TEXT,
            PRIMARY KEY (node_a, node_b)
        );
        CREATE TABLE IF NOT EXISTS event_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            icon TEXT,
            message TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS road_alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            driver_id TEXT NOT NULL,
            node_a TEXT NOT NULL,
            node_b TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            created_at TEXT NOT NULL,
            dismissed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS trips (
            id TEXT PRIMARY KEY,
            driver_id TEXT NOT NULL,
            driver_name TEXT NOT NULL,
            vehicle_type TEXT NOT NULL,
            stops TEXT NOT NULL,
            node_path TEXT NOT NULL,
            distance_m REAL NOT NULL,
            time_s REAL NOT NULL,
            assigned_at TEXT NOT NULL,
            completed_at TEXT,
            photo_filename TEXT,
            graph_fingerprint TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS node_selection_counts (
            node_id TEXT PRIMARY KEY,
            count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS graph_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            fingerprint TEXT
        );
        """
    )
    driver_cols = {row["name"] for row in conn.execute("PRAGMA table_info(drivers)").fetchall()}
    if "photo_filename" not in driver_cols:
        conn.execute("ALTER TABLE drivers ADD COLUMN photo_filename TEXT")
    if "last_node_id" not in driver_cols:
        conn.execute("ALTER TABLE drivers ADD COLUMN last_node_id TEXT")
    if "idle_since" not in driver_cols:
        conn.execute("ALTER TABLE drivers ADD COLUMN idle_since TEXT")
    if "vehicle_type" not in driver_cols:
        conn.execute("ALTER TABLE drivers ADD COLUMN vehicle_type TEXT NOT NULL DEFAULT 'auto'")
    if "max_capacity_kg" not in driver_cols:
        conn.execute("ALTER TABLE drivers ADD COLUMN max_capacity_kg REAL")

    # backfill de choferes idle creados antes de este ancla de paseo (last_node_id/idle_since):
    # sin esto se quedarían sin posición y nunca aparecerían paseando por el mapa
    warehouse_row = conn.execute("SELECT node_id FROM warehouse WHERE id = 1").fetchone()
    if warehouse_row and warehouse_row["node_id"]:
        conn.execute(
            "UPDATE drivers SET last_node_id = ?, idle_since = ? "
            "WHERE status = 'idle' AND last_node_id IS NULL",
            (warehouse_row["node_id"], datetime.now(timezone.utc).isoformat()),
        )

    # si el grafo cambió desde la última vez que arrancó el backend (editor+notebook lo
    # regeneraron), los node_id ya no representan los mismos lugares: reiniciar el
    # contador de "nodos más pedidos" de Historial > Reportes. El historial de viajes en
    # sí NO se borra (cada fila guarda su propio graph_fingerprint para saber si su
    # mini-mapa sigue siendo válido).
    meta_row = conn.execute("SELECT fingerprint FROM graph_meta WHERE id = 1").fetchone()
    if meta_row is None or meta_row["fingerprint"] != GRAPH_FINGERPRINT:
        conn.execute("DELETE FROM node_selection_counts")
        conn.execute(
            "INSERT OR REPLACE INTO graph_meta (id, fingerprint) VALUES (1, ?)", (GRAPH_FINGERPRINT,)
        )

    conn.commit()
    conn.close()


init_db()


def canonical_pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


VEHICLE_TYPES = ("moto", "auto", "noa", "camion")


WEATHER_CODES = {
    0: "despejado", 1: "mayormente despejado", 2: "parcialmente nublado", 3: "nublado",
    45: "con niebla", 48: "con niebla helada",
    51: "con llovizna ligera", 53: "con llovizna moderada", 55: "con llovizna densa",
    56: "con llovizna helada", 57: "con llovizna helada densa",
    61: "con lluvia ligera", 63: "con lluvia moderada", 65: "con lluvia fuerte",
    66: "con lluvia helada", 67: "con lluvia helada fuerte",
    71: "con nieve ligera", 73: "con nieve moderada", 75: "con nieve fuerte", 77: "con nieve granulada",
    80: "con chubascos ligeros", 81: "con chubascos moderados", 82: "con chubascos fuertes",
    85: "con chubascos de nieve ligeros", 86: "con chubascos de nieve fuertes",
    95: "con tormenta eléctrica", 96: "con tormenta y granizo ligero", 99: "con tormenta y granizo fuerte",
}
DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"]


def weather_description(code) -> str:
    return WEATHER_CODES.get(code, "condición desconocida")


def _geocode_query(query_str: str, count: int = 5) -> list:
    url = "https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode(
        {"name": query_str, "count": count, "language": "es"}
    )
    with urllib.request.urlopen(url, timeout=8) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("results") or []


def _format_place(r: dict):
    label = r["name"]
    if r.get("admin1"):
        label += ", " + r["admin1"]
    if r.get("country"):
        label += ", " + r["country"]
    return r["latitude"], r["longitude"], label


def geocode_place(name: str, bias_country: str | None = None):
    # EasyRoute opera en Bolivia: para lugares ambiguos ("La Paz" también existe en México,
    # Honduras, Argentina...) se prefiere la coincidencia del país de sesgo entre los primeros
    # resultados, en vez de asumir que el primer resultado global es el correcto.
    results = _geocode_query(name)
    if not results:
        return None
    if bias_country:
        for r in results:
            if (r.get("country") or "").lower() == bias_country.lower():
                return _format_place(r)
    return _format_place(results[0])


def fetch_weather(lat: float, lon: float) -> dict:
    url = "https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(
        {
            "latitude": lat,
            "longitude": lon,
            "current": "temperature_2m,precipitation,weather_code",
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
            "timezone": "auto",
            "forecast_days": 7,
        }
    )
    with urllib.request.urlopen(url, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_weather_resumen(place_label: str, weather: dict) -> str:
    current = weather.get("current", {})
    daily = weather.get("daily", {})
    parts = [
        "Lugar: " + place_label + ".",
        "Ahora: " + str(current.get("temperature_2m")) + "°C, "
        + weather_description(current.get("weather_code")) + ".",
    ]
    dates = daily.get("time", [])
    tmax = daily.get("temperature_2m_max", [])
    tmin = daily.get("temperature_2m_min", [])
    pprob = daily.get("precipitation_probability_max", [])
    codes = daily.get("weather_code", [])
    days = []
    for i, date_str in enumerate(dates):
        try:
            label = DAY_NAMES[datetime.strptime(date_str, "%Y-%m-%d").weekday()]
        except ValueError:
            label = date_str
        days.append(
            label + ": " + str(tmin[i]) + "-" + str(tmax[i]) + "°C, "
            + weather_description(codes[i]) + ", prob. lluvia " + str(pprob[i]) + "%"
        )
    parts.append("Pronóstico 7 días: " + "; ".join(days) + ".")
    return " ".join(parts)


def _normalize(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    return s.strip().lower()


def resolve_driver_by_name(conn, name_query: str):
    q = _normalize(name_query)
    rows = conn.execute("SELECT id, name, status FROM drivers").fetchall()
    for r in rows:
        if _normalize(r["name"]) == q:
            return r
    candidates = [r for r in rows if q in _normalize(r["name"]) or _normalize(r["name"]) in q]
    return candidates[0] if len(candidates) == 1 else None


def resolve_node(mention: str):
    """Resuelve un nodo por número ('59', 'nodo 59') o por coincidencia de nombre
    ('5to Anillo y Doble Vía'). Devuelve (nodo, None) si hay una única coincidencia,
    (None, candidatos) si es ambiguo, o (None, None) si no se encontró nada."""
    q = mention.strip()
    if re.fullmatch(r"\d+", q):
        node_id = NUMBER_TO_ID.get(int(q))
        if node_id is not None:
            return NODES_BY_ID[node_id], None

    q_norm = _normalize(q)
    nodes = list(NODES_BY_ID.values())
    exact = [n for n in nodes if _normalize(n["name"]) == q_norm]
    if len(exact) == 1:
        return exact[0], None

    candidates = [n for n in nodes if q_norm in _normalize(n["name"]) or _normalize(n["name"]) in q_norm]
    if len(candidates) == 1:
        return candidates[0], None
    if len(candidates) > 1:
        return None, candidates
    return None, None


def respond_ambiguous_nodes(query: str, mention: str, candidates: list):
    names = [c["name"] for c in candidates]
    resumen = (
        "El usuario mencionó '" + mention + "' pero hay varias coincidencias posibles: "
        + ", ".join(names) + ". Pregúntale cuál de estas opciones es, listándolas todas."
    )
    try:
        respuesta = manager_confirm_chain.invoke({"query": query, "resumen": resumen})
    except Exception:
        respuesta = "Hay varias coincidencias con '" + mention + "': " + ", ".join(names) + ". ¿Cuál de estas es?"
    return jsonify(intent="aclaracion", respuesta=respuesta)


class ManagerIntent(BaseModel):
    intent: Literal["consulta_tiempo", "despacho", "clima", "otro"] = Field(
        description="'consulta_tiempo' si pregunta cuánto tiempo/distancia toma llegar a un "
        "nodo; 'despacho' si pide enviar/asignar a un chofer a hacer una entrega en una o más "
        "paradas; 'clima' si pregunta por el clima, temperatura, lluvia o pronóstico de algún "
        "lugar; 'otro' si no corresponde a ninguno de los anteriores."
    )
    origen_lugar: str | None = Field(
        None,
        description="Nodo de origen mencionado explícitamente (puede ser un número, "
        "'nodo N', o el nombre de una intersección/lugar, ej. '5to Anillo y Doble Vía'). "
        "Si la pregunta dice 'desde el almacén'/'depósito' o no menciona origen, deja null.",
    )
    destino_lugar: str | None = Field(
        None,
        description="Nodo destino mencionado (número o nombre de lugar/intersección), "
        "solo para intent='consulta_tiempo'.",
    )
    chofer_nombre: str | None = Field(
        None, description="Nombre del chofer mencionado, solo para intent='despacho'."
    )
    paradas_lugares: list[str] = Field(
        default_factory=list,
        description="Paradas a visitar (cada una: número o nombre de lugar/intersección), "
        "solo para intent='despacho'.",
    )
    lugar: str | None = Field(
        None,
        description="Lugar mencionado (ciudad/zona) para intent='clima'. Si no mencionan "
        "ninguno, deja este campo null.",
    )


manager_intent_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "Interpretas pedidos en un gestor de reparto sobre un grafo vial. Los nodos se "
            "identifican por un número ('nodo 34') o por el nombre de una intersección/lugar "
            "('5to Anillo y Doble Vía'). Clasifica el pedido como 'consulta_tiempo' (preguntan "
            "cuánto tarda/cuánto falta a un nodo), 'despacho' (piden enviar un chofer a una o "
            "más paradas), 'clima' (preguntan por el clima, temperatura, lluvia o pronóstico de "
            "algún lugar) u 'otro'. Extrae los nodos tal como los menciona el usuario (número o "
            "nombre de lugar, sin modificarlos) y no inventes datos que no estén en el texto.",
        ),
        ("human", "{query}"),
    ]
)

manager_confirm_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "Eres el asistente del Gestor de reparto de EasyRoute. Te dan el pedido original "
            "del usuario y un resumen con los datos ya calculados (distancia, tiempo, chofer, "
            "orden de paradas). Responde en español, tono conversacional y breve (1 a 3 "
            "oraciones), confirmando el dato o la acción usando exclusivamente los "
            "números/nombres del resumen. No inventes cifras ni repitas el pedido textualmente.",
        ),
        ("human", "Pedido: {query}\nResumen: {resumen}"),
    ]
)

llm = ChatGoogleGenerativeAI(model="gemini-3.1-flash-lite")
manager_intent_chain = manager_intent_prompt | llm.with_structured_output(ManagerIntent)
manager_confirm_chain = manager_confirm_prompt | llm | StrOutputParser()


class PackageAnalysis(BaseModel):
    descripcion: str = Field(
        description="Breve descripción en español de lo que se ve en la foto (ej. 'una bolsa de "
        "plástico con productos medianos', 'una caja de cartón grande'). No menciones el vehículo aquí."
    )
    vehiculo_minimo: Literal["moto", "auto", "noa", "camion"] = Field(
        description=(
            "El vehículo MÁS CHICO que alcanza para transportar esto (no el más grande posible). "
            "Escala de menor a mayor tamaño/peso, con ejemplos concretos: "
            "'moto' — una bolsa o caja chica de mano, un sobre/paquete, algo que entra en una mochila "
            "o en el compartimento bajo el asiento de una moto (hasta ~5-8 kg; ej. una bolsa de "
            "mercado, un par de cajas de zapatos, un paquete pequeño). "
            "'auto' — una caja o bolsa mediana, varias bolsas de compras, algo que entra en el asiento "
            "trasero o el baúl de un auto sin ocupar todo el espacio (ej. una caja de electrodoméstico "
            "chico, dos o tres cajas medianas apiladas). "
            "'noa' (furgoneta tipo Toyota Noah) — carga voluminosa que ya no entra cómoda en un auto: "
            "varias cajas grandes, un electrodoméstico mediano o grande, una mudanza chica. "
            "'camion' — carga grande, pesada, o muchas unidades juntas (pallets, muebles grandes, "
            "materiales de construcción). "
            "Elegí SIEMPRE el vehículo más chico que sea razonable para el tamaño real que ves en la "
            "foto — no asumas que hace falta algo más grande de lo necesario."
        )
    )


package_vision_llm = llm.with_structured_output(PackageAnalysis)
PACKAGE_VISION_INSTRUCTIONS = (
    "Sos un asistente logístico de EasyRoute. Analiza esta foto de un encargo/paquete a entregar: "
    "describí brevemente qué es y qué tan grande parece (tamaño relativo — no inventes un peso "
    "exacto), y clasificá el vehículo MÁS CHICO que alcanza para llevarlo, siguiendo la escala "
    "moto < auto < furgoneta (noa) < camión. No elijas un vehículo más grande de lo necesario."
)

app = Flask(__name__)
CORS(app)  # dev local: frontend estático y backend corren en orígenes distintos


@app.route("/manager/chat/parse", methods=["POST"])
def manager_chat_parse():
    body = request.get_json(silent=True) or {}
    query = (body.get("query") or "").strip()
    if not query:
        return jsonify(error="El pedido está vacío."), 400

    try:
        result = manager_intent_chain.invoke({"query": query})
    except Exception as exc:  # error de LLM/parsing
        return jsonify(error=f"No se pudo interpretar el pedido: {exc}"), 502

    conn = get_db()
    try:
        warehouse_row = conn.execute("SELECT node_id FROM warehouse WHERE id = 1").fetchone()
        warehouse_id = warehouse_row["node_id"] if warehouse_row else None

        if result.intent == "consulta_tiempo":
            if result.origen_lugar:
                origen_node, origen_candidates = resolve_node(result.origen_lugar)
                if origen_candidates:
                    return respond_ambiguous_nodes(query, result.origen_lugar, origen_candidates)
                if origen_node is None:
                    return jsonify(error=f"No encontré ningún nodo que coincida con '{result.origen_lugar}'."), 404
                origen_id = origen_node["id"]
            else:
                origen_id = warehouse_id
            if origen_id is None:
                return jsonify(error="No hay un almacén fijado ni se indicó un origen válido."), 400

            if not result.destino_lugar:
                return jsonify(error="No entendí a qué nodo te referís."), 400
            destino_node, destino_candidates = resolve_node(result.destino_lugar)
            if destino_candidates:
                return respond_ambiguous_nodes(query, result.destino_lugar, destino_candidates)
            if destino_node is None:
                return jsonify(error=f"No encontré ningún nodo que coincida con '{result.destino_lugar}'."), 404

            return jsonify(
                intent="consulta_tiempo",
                origen_id=origen_id,
                origen_nombre=NODES_BY_ID[origen_id]["name"],
                destino_id=destino_node["id"],
                destino_nombre=destino_node["name"],
            )

        if result.intent == "despacho":
            if not result.chofer_nombre:
                return jsonify(error="No entendí a qué chofer enviar."), 400
            driver_row = resolve_driver_by_name(conn, result.chofer_nombre)
            if driver_row is None:
                return jsonify(error=f"No encontré un chofer llamado '{result.chofer_nombre}'."), 404
            if driver_row["status"] != "idle":
                return jsonify(error=f"{driver_row['name']} ya está en una ruta."), 409
            if not result.paradas_lugares:
                return jsonify(error="No entendí las paradas de la entrega."), 400
            if warehouse_id is None:
                return jsonify(error="Primero fija el almacén."), 400
            paradas_ids = []
            paradas_nombres = []
            for mention in result.paradas_lugares:
                node, candidates = resolve_node(mention)
                if candidates:
                    return respond_ambiguous_nodes(query, mention, candidates)
                if node is None:
                    return jsonify(error=f"No encontré ningún nodo que coincida con '{mention}'."), 400
                paradas_ids.append(node["id"])
                paradas_nombres.append(node["name"])
            return jsonify(
                intent="despacho",
                chofer_id=driver_row["id"],
                chofer_nombre=driver_row["name"],
                warehouse_id=warehouse_id,
                paradas_ids=paradas_ids,
                paradas_nombres=paradas_nombres,
            )

        if result.intent == "clima":
            place = (result.lugar or "Santa Cruz de la Sierra, Bolivia").strip()
            try:
                geo = geocode_place(place, bias_country="Bolivia")
            except (urllib.error.URLError, TimeoutError) as exc:
                return jsonify(error=f"No se pudo consultar el clima: {exc}"), 502
            if geo is None:
                return jsonify(error=f"No encontré el lugar '{place}'."), 404
            lat, lon, place_label = geo
            try:
                weather = fetch_weather(lat, lon)
            except (urllib.error.URLError, TimeoutError) as exc:
                return jsonify(error=f"No se pudo obtener el clima: {exc}"), 502
            resumen = build_weather_resumen(place_label, weather)
            try:
                respuesta = manager_confirm_chain.invoke({"query": query, "resumen": resumen})
            except Exception as exc:  # error de LLM
                return jsonify(error=f"No se pudo generar la respuesta: {exc}"), 502
            return jsonify(intent="clima", respuesta=respuesta)

        return jsonify(intent="otro")
    finally:
        conn.close()


@app.route("/manager/chat/confirm", methods=["POST"])
def manager_chat_confirm():
    body = request.get_json(silent=True) or {}
    query = (body.get("query") or "").strip()
    resumen = (body.get("resumen") or "").strip()
    if not query or not resumen:
        return jsonify(error="Faltan datos para generar la respuesta."), 400

    try:
        respuesta = manager_confirm_chain.invoke({"query": query, "resumen": resumen})
    except Exception as exc:  # error de LLM o payload mal formado
        return jsonify(error=f"No se pudo generar la respuesta: {exc}"), 502

    return jsonify(respuesta=respuesta)


TRAFFIC_LEVELS = {"bajo", "medio", "alto"}


def photo_url_for(filename) -> str | None:
    return f"/manager/photos/{filename}" if filename else None


def load_manager_state() -> dict:
    conn = get_db()
    warehouse_row = conn.execute("SELECT node_id FROM warehouse WHERE id = 1").fetchone()
    driver_rows = conn.execute(
        "SELECT id, name, status, route_json, assigned_at, photo_filename, last_node_id, idle_since, "
        "vehicle_type, max_capacity_kg FROM drivers"
    ).fetchall()
    traffic_rows = conn.execute("SELECT node_id, level FROM node_traffic").fetchall()
    blocked_rows = conn.execute("SELECT node_a, node_b, reason, blocked_at FROM blocked_edges").fetchall()
    alert_rows = conn.execute(
        "SELECT id, driver_id, node_a, node_b, lat, lng, created_at FROM road_alerts WHERE dismissed = 0"
    ).fetchall()
    conn.close()

    drivers = []
    for row in driver_rows:
        route = json.loads(row["route_json"]) if row["route_json"] else None
        if route is not None:
            # la columna assigned_at de drivers es la fuente de verdad: siempre está
            # bien sincronizada, a diferencia de la copia embebida en route_json
            # (rutas asignadas antes de este fix se guardaron sin ese campo)
            route["assigned_at"] = row["assigned_at"]
        drivers.append({
            "id": row["id"],
            "name": row["name"],
            "status": row["status"],
            "route": route,
            "assigned_at": row["assigned_at"],
            "photo_url": photo_url_for(row["photo_filename"]),
            "last_node_id": row["last_node_id"],
            "idle_since": row["idle_since"],
            "vehicle_type": row["vehicle_type"],
            "max_capacity_kg": row["max_capacity_kg"],
        })

    return {
        "warehouse_node_id": warehouse_row["node_id"] if warehouse_row else None,
        "drivers": drivers,
        "traffic": {r["node_id"]: r["level"] for r in traffic_rows},
        "blocked_edges": [
            {"node_a": r["node_a"], "node_b": r["node_b"], "reason": r["reason"], "blocked_at": r["blocked_at"]}
            for r in blocked_rows
        ],
        "alerts": [
            {
                "id": r["id"], "driver_id": r["driver_id"], "node_a": r["node_a"], "node_b": r["node_b"],
                "lat": r["lat"], "lng": r["lng"], "created_at": r["created_at"],
            }
            for r in alert_rows
        ],
    }


@app.route("/manager/state", methods=["GET"])
def manager_get_state():
    return jsonify(load_manager_state())


@app.route("/manager/warehouse", methods=["POST"])
def manager_set_warehouse():
    body = request.get_json(silent=True) or {}
    node_id = body.get("node_id")
    if node_id not in NODES_BY_ID:
        return jsonify(error=f"El nodo {node_id} no existe en el grafo."), 400

    conn = get_db()
    conn.execute("INSERT OR REPLACE INTO warehouse (id, node_id) VALUES (1, ?)", (node_id,))
    conn.commit()
    conn.close()
    return jsonify(load_manager_state())


@app.route("/manager/drivers", methods=["POST"])
def manager_add_driver():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify(error="El nombre del chofer no puede estar vacío."), 400

    vehicle_type = body.get("vehicle_type")
    if vehicle_type not in VEHICLE_TYPES:
        vehicle_type = "auto"
    max_capacity_kg = body.get("max_capacity_kg")
    if max_capacity_kg is not None:
        try:
            max_capacity_kg = float(max_capacity_kg)
        except (TypeError, ValueError):
            max_capacity_kg = None

    conn = get_db()
    warehouse_row = conn.execute("SELECT node_id FROM warehouse WHERE id = 1").fetchone()
    last_node_id = warehouse_row["node_id"] if warehouse_row else None
    idle_since = datetime.now(timezone.utc).isoformat()

    driver = {
        "id": uuid.uuid4().hex[:8], "name": name, "status": "idle", "route": None, "assigned_at": None,
        "photo_url": None, "last_node_id": last_node_id, "idle_since": idle_since,
        "vehicle_type": vehicle_type, "max_capacity_kg": max_capacity_kg,
    }
    conn.execute(
        "INSERT INTO drivers (id, name, status, route_json, assigned_at, last_node_id, idle_since, "
        "vehicle_type, max_capacity_kg) VALUES (?, ?, 'idle', NULL, NULL, ?, ?, ?, ?)",
        (driver["id"], name, last_node_id, idle_since, vehicle_type, max_capacity_kg),
    )
    conn.commit()
    conn.close()
    return jsonify(driver), 201


@app.route("/manager/drivers/<driver_id>/settings", methods=["POST"])
def manager_update_driver_settings(driver_id):
    body = request.get_json(silent=True) or {}
    conn = get_db()
    row = conn.execute("SELECT id FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404

    updates, params = [], []
    if "vehicle_type" in body:
        vehicle_type = body.get("vehicle_type")
        if vehicle_type not in VEHICLE_TYPES:
            conn.close()
            return jsonify(error="Tipo de vehículo inválido."), 400
        updates.append("vehicle_type = ?")
        params.append(vehicle_type)
    if "max_capacity_kg" in body:
        max_capacity_kg = body.get("max_capacity_kg")
        if max_capacity_kg is not None:
            try:
                max_capacity_kg = float(max_capacity_kg)
            except (TypeError, ValueError):
                conn.close()
                return jsonify(error="Capacidad inválida."), 400
            if max_capacity_kg < 0:
                conn.close()
                return jsonify(error="Capacidad inválida."), 400
        updates.append("max_capacity_kg = ?")
        params.append(max_capacity_kg)

    if not updates:
        conn.close()
        return jsonify(error="Nada que actualizar."), 400

    params.append(driver_id)
    conn.execute(f"UPDATE drivers SET {', '.join(updates)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT vehicle_type, max_capacity_kg FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    conn.close()
    return jsonify({"id": driver_id, "vehicle_type": row["vehicle_type"], "max_capacity_kg": row["max_capacity_kg"]})


@app.route("/manager/drivers/<driver_id>", methods=["DELETE"])
def manager_delete_driver(driver_id):
    conn = get_db()
    row = conn.execute("SELECT status FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404
    if row["status"] == "en_ruta":
        conn.close()
        return jsonify(error="No se puede eliminar un chofer en ruta."), 409
    conn.execute("DELETE FROM drivers WHERE id = ?", (driver_id,))
    conn.commit()
    conn.close()
    return jsonify(load_manager_state())


@app.route("/manager/drivers/<driver_id>/assign", methods=["POST"])
def manager_assign_route(driver_id):
    body = request.get_json(silent=True) or {}
    required = [
        "stops", "node_path", "polyline", "distance_m", "time_s",
        "pickup_node_path", "pickup_polyline", "pickup_distance_m", "pickup_time_s",
    ]
    if not all(k in body for k in required):
        return jsonify(error="Faltan datos de la ruta."), 400

    conn = get_db()
    row = conn.execute("SELECT status, name, vehicle_type FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404
    if row["status"] != "idle":
        conn.close()
        return jsonify(error="El chofer ya tiene una ruta asignada."), 409

    assigned_at = datetime.now(timezone.utc).isoformat()
    route = {
        "stops": body["stops"],
        "node_path": body["node_path"],
        "polyline": body["polyline"],
        "distance_m": body["distance_m"],
        "time_s": body["time_s"],
        "peak_hour": bool(body.get("peak_hour", False)),
        "pickup_node_path": body["pickup_node_path"],
        "pickup_polyline": body["pickup_polyline"],
        "pickup_distance_m": body["pickup_distance_m"],
        "pickup_time_s": body["pickup_time_s"],
        # hop parcial desde la posición EXACTA del chofer (a mitad de una calle mientras
        # paseaba) hasta el primer nodo de pickup_node_path; None si ya estaba justo en un nodo
        "pickup_partial_from": body.get("pickup_partial_from"),
        "pickup_partial_to": body.get("pickup_partial_to"),
        "pickup_partial_start_dist_m": body.get("pickup_partial_start_dist_m", 0),
        "assigned_at": assigned_at,
    }
    conn.execute(
        "UPDATE drivers SET status = 'en_ruta', route_json = ?, assigned_at = ? WHERE id = ?",
        (json.dumps(route, ensure_ascii=False), assigned_at, driver_id),
    )

    trip_id = uuid.uuid4().hex
    conn.execute(
        "INSERT INTO trips (id, driver_id, driver_name, vehicle_type, stops, node_path, "
        "distance_m, time_s, assigned_at, completed_at, photo_filename, graph_fingerprint) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
        (
            trip_id, driver_id, row["name"], row["vehicle_type"],
            json.dumps(body["stops"], ensure_ascii=False), json.dumps(body["node_path"], ensure_ascii=False),
            body["distance_m"], body["time_s"], assigned_at, GRAPH_FINGERPRINT,
        ),
    )
    for node_id in body["stops"]:
        conn.execute(
            "INSERT INTO node_selection_counts (node_id, count) VALUES (?, 1) "
            "ON CONFLICT(node_id) DO UPDATE SET count = count + 1",
            (node_id,),
        )

    conn.commit()
    conn.close()
    return jsonify({"id": driver_id, "status": "en_ruta", "route": route, "trip_id": trip_id})


@app.route("/manager/drivers/<driver_id>/complete", methods=["POST"])
def manager_complete_route(driver_id):
    conn = get_db()
    row = conn.execute("SELECT status, route_json, last_node_id FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404

    last_node_id = row["last_node_id"]
    if row["route_json"]:
        node_path = json.loads(row["route_json"]).get("node_path")
        if node_path:
            last_node_id = node_path[-1]
    idle_since = datetime.now(timezone.utc).isoformat()

    # UPDATE...WHERE status='en_ruta' + rowcount es atómico a nivel SQL: si dos pestañas
    # llaman a este endpoint casi al mismo tiempo para el mismo chofer, solo una de las dos
    # consigue actualizar la fila (SQLite serializa escrituras concurrentes), sin depender de
    # que el servidor Flask sea single-threaded (que en la práctica no siempre lo es)
    cur = conn.execute(
        "UPDATE drivers SET status = 'idle', route_json = NULL, assigned_at = NULL, "
        "last_node_id = ?, idle_since = ? WHERE id = ? AND status = 'en_ruta'",
        (last_node_id, idle_since, driver_id),
    )
    was_en_ruta = cur.rowcount > 0
    if was_en_ruta:
        conn.execute(
            "UPDATE trips SET completed_at = ? WHERE driver_id = ? AND completed_at IS NULL",
            (idle_since, driver_id),
        )
    conn.commit()
    conn.close()
    return jsonify({"id": driver_id, "status": "idle", "route": None, "was_en_ruta": was_en_ruta})


@app.route("/manager/log", methods=["GET"])
def manager_get_log():
    date_from = request.args.get("from")
    date_to = request.args.get("to")
    conn = get_db()
    if date_from and date_to:
        rows = conn.execute(
            "SELECT id, ts, icon, message FROM event_log WHERE ts >= ? AND ts < ? ORDER BY id ASC",
            (date_from, date_to),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, ts, icon, message FROM ("
            "  SELECT id, ts, icon, message FROM event_log ORDER BY id DESC LIMIT 200"
            ") sub ORDER BY id ASC"
        ).fetchall()
    conn.close()
    return jsonify([{"id": r["id"], "ts": r["ts"], "icon": r["icon"], "message": r["message"]} for r in rows])


@app.route("/manager/log", methods=["POST"])
def manager_post_log():
    body = request.get_json(silent=True) or {}
    message = (body.get("message") or "").strip()
    if not message:
        return jsonify(error="El mensaje no puede estar vacío."), 400
    icon = body.get("icon") or None
    ts = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    cur = conn.execute("INSERT INTO event_log (ts, icon, message) VALUES (?, ?, ?)", (ts, icon, message))
    conn.commit()
    row_id = cur.lastrowid
    conn.close()
    return jsonify({"id": row_id, "ts": ts, "icon": icon, "message": message}), 201


@app.route("/manager/traffic", methods=["POST"])
def manager_set_traffic():
    body = request.get_json(silent=True) or {}
    node_id = body.get("node_id")
    level = body.get("level")
    if node_id not in NODES_BY_ID:
        return jsonify(error=f"El nodo {node_id} no existe en el grafo."), 400

    conn = get_db()
    if not level or level == "ninguno":
        conn.execute("DELETE FROM node_traffic WHERE node_id = ?", (node_id,))
    elif level in TRAFFIC_LEVELS:
        conn.execute("INSERT OR REPLACE INTO node_traffic (node_id, level) VALUES (?, ?)", (node_id, level))
    else:
        conn.close()
        return jsonify(error="Nivel de tráfico inválido."), 400
    conn.commit()
    traffic_rows = conn.execute("SELECT node_id, level FROM node_traffic").fetchall()
    conn.close()
    return jsonify({r["node_id"]: r["level"] for r in traffic_rows})


@app.route("/manager/blocked-edges", methods=["POST"])
def manager_block_edge():
    body = request.get_json(silent=True) or {}
    node_a = body.get("node_a")
    node_b = body.get("node_b")
    reason = (body.get("reason") or "Bloqueado").strip() or "Bloqueado"

    if node_a not in NODES_BY_ID or node_b not in NODES_BY_ID:
        return jsonify(error="Uno de los nodos no existe en el grafo."), 400
    if frozenset({node_a, node_b}) not in EDGE_PAIRS:
        return jsonify(error="No hay una calle directa entre esos nodos."), 400

    a, b = canonical_pair(node_a, node_b)
    blocked_at = datetime.now(timezone.utc).isoformat()
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO blocked_edges (node_a, node_b, reason, blocked_at) VALUES (?, ?, ?, ?)",
        (a, b, reason, blocked_at),
    )
    conn.commit()
    blocked_rows = conn.execute("SELECT node_a, node_b, reason, blocked_at FROM blocked_edges").fetchall()
    conn.close()
    return jsonify([
        {"node_a": r["node_a"], "node_b": r["node_b"], "reason": r["reason"], "blocked_at": r["blocked_at"]}
        for r in blocked_rows
    ]), 201


@app.route("/manager/blocked-edges/<node_a>/<node_b>", methods=["DELETE"])
def manager_unblock_edge(node_a, node_b):
    a, b = canonical_pair(node_a, node_b)
    conn = get_db()
    conn.execute("DELETE FROM blocked_edges WHERE node_a = ? AND node_b = ?", (a, b))
    conn.commit()
    blocked_rows = conn.execute("SELECT node_a, node_b, reason, blocked_at FROM blocked_edges").fetchall()
    conn.close()
    return jsonify([
        {"node_a": r["node_a"], "node_b": r["node_b"], "reason": r["reason"], "blocked_at": r["blocked_at"]}
        for r in blocked_rows
    ])


def _alerts_response():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, driver_id, node_a, node_b, lat, lng, created_at FROM road_alerts WHERE dismissed = 0"
    ).fetchall()
    conn.close()
    return [
        {
            "id": r["id"], "driver_id": r["driver_id"], "node_a": r["node_a"], "node_b": r["node_b"],
            "lat": r["lat"], "lng": r["lng"], "created_at": r["created_at"],
        }
        for r in rows
    ]


@app.route("/manager/alerts", methods=["POST"])
def manager_create_alert():
    body = request.get_json(silent=True) or {}
    driver_id = body.get("driver_id")
    node_a = body.get("node_a")
    node_b = body.get("node_b")
    lat = body.get("lat")
    lng = body.get("lng")

    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return jsonify(error="Coordenadas inválidas."), 400
    if node_a not in NODES_BY_ID or node_b not in NODES_BY_ID:
        return jsonify(error="Uno de los nodos no existe en el grafo."), 400
    if frozenset({node_a, node_b}) not in EDGE_PAIRS:
        return jsonify(error="No hay una calle directa entre esos nodos."), 400

    conn = get_db()
    driver_row = conn.execute("SELECT name FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if driver_row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404

    a, b = canonical_pair(node_a, node_b)
    created_at = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO road_alerts (driver_id, node_a, node_b, lat, lng, created_at, dismissed) "
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
        (driver_id, a, b, lat, lng, created_at),
    )
    conn.execute(
        "INSERT INTO event_log (ts, icon, message) VALUES (?, ?, ?)",
        (created_at, "❗", driver_row["name"] + " reportó una trancadera"),
    )
    conn.commit()
    conn.close()
    return jsonify(_alerts_response()), 201


@app.route("/manager/alerts/<int:alert_id>", methods=["DELETE"])
def manager_dismiss_alert(alert_id):
    conn = get_db()
    conn.execute("UPDATE road_alerts SET dismissed = 1 WHERE id = ?", (alert_id,))
    conn.commit()
    conn.close()
    return jsonify(_alerts_response())


PHOTO_MIME_TYPES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp"}


@app.route("/manager/analyze-package", methods=["POST"])
def manager_analyze_package():
    file = request.files.get("photo")
    if file is None or not file.filename:
        return jsonify(error="No se recibió ninguna imagen."), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_PHOTO_EXT:
        return jsonify(error="Formato de imagen no permitido (usa png, jpg, jpeg, gif o webp)."), 400

    image_b64 = base64.b64encode(file.read()).decode("ascii")
    message = HumanMessage(content=[
        {"type": "text", "text": PACKAGE_VISION_INSTRUCTIONS},
        {"type": "image_url", "image_url": f"data:{PHOTO_MIME_TYPES[ext]};base64,{image_b64}"},
    ])
    try:
        result = package_vision_llm.invoke([message])
    except Exception as exc:  # error de LLM/parsing
        return jsonify(error=f"No se pudo analizar la imagen: {exc}"), 502

    return jsonify(descripcion=result.descripcion, vehiculo_minimo=result.vehiculo_minimo)


@app.route("/manager/drivers/<driver_id>/photo", methods=["POST"])
def manager_upload_driver_photo(driver_id):
    conn = get_db()
    row = conn.execute("SELECT id, photo_filename FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404

    file = request.files.get("photo")
    if file is None or not file.filename:
        conn.close()
        return jsonify(error="No se recibió ninguna imagen."), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_PHOTO_EXT:
        conn.close()
        return jsonify(error="Formato de imagen no permitido (usa png, jpg, jpeg, gif o webp)."), 400

    filename = f"{driver_id}.{ext}"
    file.save(PHOTOS_DIR / filename)
    conn.execute("UPDATE drivers SET photo_filename = ? WHERE id = ?", (filename, driver_id))
    conn.commit()
    conn.close()
    return jsonify({"id": driver_id, "photo_url": photo_url_for(filename)})


@app.route("/manager/photos/<path:filename>", methods=["GET"])
def manager_get_photo(filename):
    return send_from_directory(PHOTOS_DIR, filename)


def package_photo_url_for(filename) -> str | None:
    return f"/manager/package-photos/{filename}" if filename else None


@app.route("/manager/trips/<trip_id>/photo", methods=["POST"])
def manager_upload_trip_photo(trip_id):
    conn = get_db()
    row = conn.execute("SELECT id FROM trips WHERE id = ?", (trip_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Viaje no encontrado."), 404

    file = request.files.get("photo")
    if file is None or not file.filename:
        conn.close()
        return jsonify(error="No se recibió ninguna imagen."), 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_PHOTO_EXT:
        conn.close()
        return jsonify(error="Formato de imagen no permitido (usa png, jpg, jpeg, gif o webp)."), 400

    filename = f"{trip_id}.{ext}"
    file.save(PACKAGE_PHOTOS_DIR / filename)
    conn.execute("UPDATE trips SET photo_filename = ? WHERE id = ?", (filename, trip_id))
    conn.commit()
    conn.close()
    return jsonify({"id": trip_id, "photo_url": package_photo_url_for(filename)})


@app.route("/manager/package-photos/<path:filename>", methods=["GET"])
def manager_get_package_photo(filename):
    return send_from_directory(PACKAGE_PHOTOS_DIR, filename)


@app.route("/manager/trips", methods=["GET"])
def manager_list_trips():
    date_from = request.args.get("from")
    date_to = request.args.get("to")
    conn = get_db()
    if date_from and date_to:
        rows = conn.execute(
            "SELECT * FROM trips WHERE assigned_at >= ? AND assigned_at < ? ORDER BY assigned_at DESC",
            (date_from, date_to),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM trips ORDER BY assigned_at DESC LIMIT 200").fetchall()
    conn.close()
    return jsonify([
        {
            "id": r["id"],
            "driver_id": r["driver_id"],
            "driver_name": r["driver_name"],
            "vehicle_type": r["vehicle_type"],
            "stops": json.loads(r["stops"]),
            "node_path": json.loads(r["node_path"]),
            "distance_m": r["distance_m"],
            "time_s": r["time_s"],
            "assigned_at": r["assigned_at"],
            "completed_at": r["completed_at"],
            "photo_url": package_photo_url_for(r["photo_filename"]),
            "graph_matches": r["graph_fingerprint"] == GRAPH_FINGERPRINT,
        }
        for r in rows
    ])


@app.route("/manager/node-selection-counts", methods=["GET"])
def manager_node_selection_counts():
    conn = get_db()
    rows = conn.execute("SELECT node_id, count FROM node_selection_counts").fetchall()
    conn.close()
    return jsonify({r["node_id"]: r["count"] for r in rows})


if __name__ == "__main__":
    app.run(port=5000, debug=True)
