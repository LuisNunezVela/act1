"""Backend LangChain para EasyRoute.

Expone dos endpoints:
- POST /preguntar: recibe una pregunta en lenguaje natural sobre una ruta
  ("quiero la ruta más rápida del nodo 34 al nodo 45") y devuelve los IDs
  de nodo de origen/destino del grafo ya generado por el notebook, para que
  el frontend dispare la comparación BFS vs DFS existente sobre esos nodos.
- POST /responder: recibe la pregunta original más las métricas BFS/DFS ya
  calculadas por el frontend, y devuelve una explicación en lenguaje natural
  comparando ambos algoritmos para esa ruta específica.

No calcula rutas ni costos aquí: eso ya lo hace viz/app.js con bfs()/dfs().
Este backend solo interpreta el lenguaje natural, valida los nodos, y
redacta la respuesta conversacional con los números que le pasa el frontend.
"""
import re
import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from pydantic import BaseModel, Field
from langchain_google_genai import ChatGoogleGenerativeAI
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

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "manager_state.db"

PHOTOS_DIR = Path(__file__).resolve().parent.parent / "data" / "driver_photos"
PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
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
        """
    )
    driver_cols = {row["name"] for row in conn.execute("PRAGMA table_info(drivers)").fetchall()}
    if "photo_filename" not in driver_cols:
        conn.execute("ALTER TABLE drivers ADD COLUMN photo_filename TEXT")
    conn.commit()
    conn.close()


init_db()


def canonical_pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def resolve_driver_by_name(conn, name_query: str):
    q = name_query.strip().lower()
    rows = conn.execute("SELECT id, name, status FROM drivers").fetchall()
    for r in rows:
        if r["name"].strip().lower() == q:
            return r
    candidates = [r for r in rows if q in r["name"].strip().lower() or r["name"].strip().lower() in q]
    return candidates[0] if len(candidates) == 1 else None


class RouteQuery(BaseModel):
    origen_numero: int = Field(
        description="Número que acompaña a la palabra 'nodo' para el punto de origen mencionado en la pregunta."
    )
    destino_numero: int = Field(
        description="Número que acompaña a la palabra 'nodo' para el punto de destino mencionado en la pregunta."
    )


prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "Interpretas preguntas sobre rutas en un grafo vial. Los nodos se "
            "identifican como 'Nodo' seguido de un número (ej. 'Nodo 34'). "
            "Extrae únicamente los números de nodo de origen y destino mencionados "
            "en la pregunta del usuario. No inventes números que no estén presentes.",
        ),
        ("human", "{query}"),
    ]
)

explain_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "Eres el asistente de EasyRoute, una app que compara los algoritmos BFS y DFS "
            "para encontrar rutas de reparto en Santa Cruz de la Sierra. Te dan la pregunta "
            "original del usuario y las métricas ya calculadas de BFS y DFS para esa ruta. "
            "Responde en español, en tono conversacional y breve (2 a 4 oraciones), diciendo "
            "cuál algoritmo conviene para ese caso y por qué, usando exclusivamente los números "
            "que te dan (no inventes cifras). No repitas la pregunta del usuario textualmente.",
        ),
        (
            "human",
            "Pregunta: {query}\n"
            "Origen: {origen_nombre}. Destino: {destino_nombre}.\n"
            "BFS -> nodos explorados: {bfs_nodos}, costo: {bfs_costo:.0f} m, "
            "tiempo: {bfs_tiempo}, nodos en el camino: {bfs_pathlen}.\n"
            "DFS -> nodos explorados: {dfs_nodos}, costo: {dfs_costo:.0f} m, "
            "tiempo: {dfs_tiempo}, nodos en el camino: {dfs_pathlen}.",
        ),
    ]
)

class ManagerIntent(BaseModel):
    intent: Literal["consulta_tiempo", "despacho", "otro"] = Field(
        description="'consulta_tiempo' si pregunta cuánto tiempo/distancia toma llegar a un "
        "nodo; 'despacho' si pide enviar/asignar a un chofer a hacer una entrega en una o más "
        "paradas; 'otro' si no corresponde a ninguno de los anteriores."
    )
    origen_numero: int | None = Field(
        None,
        description="Número de nodo de origen si se menciona explícitamente. Si la pregunta "
        "dice 'desde el almacén'/'depósito' o no menciona origen, deja este campo null.",
    )
    destino_numero: int | None = Field(
        None, description="Número de nodo destino, solo para intent='consulta_tiempo'."
    )
    chofer_nombre: str | None = Field(
        None, description="Nombre del chofer mencionado, solo para intent='despacho'."
    )
    paradas_numeros: list[int] = Field(
        default_factory=list, description="Números de nodo a visitar, solo para intent='despacho'."
    )


manager_intent_prompt = ChatPromptTemplate.from_messages(
    [
        (
            "system",
            "Interpretas pedidos en un gestor de reparto sobre un grafo vial. Los nodos se "
            "identifican como 'nodo' seguido de un número. Clasifica el pedido como "
            "'consulta_tiempo' (preguntan cuánto tarda/cuánto falta a un nodo), 'despacho' "
            "(piden enviar un chofer a una o más paradas) u 'otro'. Extrae solo los números y "
            "nombres presentes en el texto, no inventes datos.",
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

llm = ChatGoogleGenerativeAI(model="gemini-flash-latest")
chain = prompt | llm.with_structured_output(RouteQuery)
explain_chain = explain_prompt | llm | StrOutputParser()
manager_intent_chain = manager_intent_prompt | llm.with_structured_output(ManagerIntent)
manager_confirm_chain = manager_confirm_prompt | llm | StrOutputParser()

app = Flask(__name__)
CORS(app)  # dev local: frontend estático y backend corren en orígenes distintos


@app.route("/preguntar", methods=["POST"])
def preguntar():
    body = request.get_json(silent=True) or {}
    query = (body.get("query") or "").strip()
    if not query:
        return jsonify(error="La pregunta está vacía."), 400

    try:
        result = chain.invoke({"query": query})
    except Exception as exc:  # error de LLM/parsing
        return jsonify(error=f"No se pudo interpretar la pregunta: {exc}"), 502

    origen_id = NUMBER_TO_ID.get(result.origen_numero)
    destino_id = NUMBER_TO_ID.get(result.destino_numero)

    if origen_id is None:
        return jsonify(error=f"No existe el Nodo {result.origen_numero} en el grafo."), 400
    if destino_id is None:
        return jsonify(error=f"No existe el Nodo {result.destino_numero} en el grafo."), 400
    if origen_id == destino_id:
        return jsonify(error="El origen y el destino no pueden ser el mismo nodo."), 400

    return jsonify(
        origen_id=origen_id,
        destino_id=destino_id,
        origen_nombre=NODES_BY_ID[origen_id]["name"],
        destino_nombre=NODES_BY_ID[destino_id]["name"],
    )


@app.route("/responder", methods=["POST"])
def responder():
    body = request.get_json(silent=True) or {}
    required = ["query", "origen_nombre", "destino_nombre", "bfs", "dfs"]
    if not all(k in body for k in required):
        return jsonify(error="Faltan datos para generar la respuesta."), 400

    try:
        respuesta = explain_chain.invoke(
            {
                "query": body["query"],
                "origen_nombre": body["origen_nombre"],
                "destino_nombre": body["destino_nombre"],
                "bfs_nodos": body["bfs"]["nodes_explored"],
                "bfs_costo": body["bfs"]["cost"],
                "bfs_tiempo": body["bfs"]["time_s"],
                "bfs_pathlen": body["bfs"]["path_length"],
                "dfs_nodos": body["dfs"]["nodes_explored"],
                "dfs_costo": body["dfs"]["cost"],
                "dfs_tiempo": body["dfs"]["time_s"],
                "dfs_pathlen": body["dfs"]["path_length"],
            }
        )
    except Exception as exc:  # error de LLM o payload mal formado
        return jsonify(error=f"No se pudo generar la respuesta: {exc}"), 502

    return jsonify(respuesta=respuesta)


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
            origen_id = NUMBER_TO_ID.get(result.origen_numero) if result.origen_numero is not None else warehouse_id
            destino_id = NUMBER_TO_ID.get(result.destino_numero) if result.destino_numero is not None else None
            if origen_id is None:
                return jsonify(error="No hay un almacén fijado ni se indicó un origen válido."), 400
            if destino_id is None:
                return jsonify(error=f"No existe el Nodo {result.destino_numero} en el grafo."), 400
            return jsonify(
                intent="consulta_tiempo",
                origen_id=origen_id,
                origen_nombre=NODES_BY_ID[origen_id]["name"],
                destino_id=destino_id,
                destino_nombre=NODES_BY_ID[destino_id]["name"],
            )

        if result.intent == "despacho":
            if not result.chofer_nombre:
                return jsonify(error="No entendí a qué chofer enviar."), 400
            driver_row = resolve_driver_by_name(conn, result.chofer_nombre)
            if driver_row is None:
                return jsonify(error=f"No encontré un chofer llamado '{result.chofer_nombre}'."), 404
            if driver_row["status"] != "idle":
                return jsonify(error=f"{driver_row['name']} ya está en una ruta."), 409
            if not result.paradas_numeros:
                return jsonify(error="No entendí las paradas de la entrega."), 400
            if warehouse_id is None:
                return jsonify(error="Primero fija el almacén."), 400
            paradas_ids = []
            for num in result.paradas_numeros:
                node_id = NUMBER_TO_ID.get(num)
                if node_id is None:
                    return jsonify(error=f"No existe el Nodo {num} en el grafo."), 400
                paradas_ids.append(node_id)
            return jsonify(
                intent="despacho",
                chofer_id=driver_row["id"],
                chofer_nombre=driver_row["name"],
                warehouse_id=warehouse_id,
                paradas_ids=paradas_ids,
                paradas_nombres=[NODES_BY_ID[i]["name"] for i in paradas_ids],
            )

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
    driver_rows = conn.execute("SELECT id, name, status, route_json, assigned_at, photo_filename FROM drivers").fetchall()
    traffic_rows = conn.execute("SELECT node_id, level FROM node_traffic").fetchall()
    blocked_rows = conn.execute("SELECT node_a, node_b, reason, blocked_at FROM blocked_edges").fetchall()
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
        })

    return {
        "warehouse_node_id": warehouse_row["node_id"] if warehouse_row else None,
        "drivers": drivers,
        "traffic": {r["node_id"]: r["level"] for r in traffic_rows},
        "blocked_edges": [
            {"node_a": r["node_a"], "node_b": r["node_b"], "reason": r["reason"], "blocked_at": r["blocked_at"]}
            for r in blocked_rows
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

    driver = {"id": uuid.uuid4().hex[:8], "name": name, "status": "idle", "route": None, "assigned_at": None, "photo_url": None}
    conn = get_db()
    conn.execute("INSERT INTO drivers (id, name, status, route_json, assigned_at) VALUES (?, ?, 'idle', NULL, NULL)",
                 (driver["id"], name))
    conn.commit()
    conn.close()
    return jsonify(driver), 201


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
    required = ["stops", "node_path", "polyline", "distance_m", "time_s"]
    if not all(k in body for k in required):
        return jsonify(error="Faltan datos de la ruta."), 400

    conn = get_db()
    row = conn.execute("SELECT status FROM drivers WHERE id = ?", (driver_id,)).fetchone()
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
        "assigned_at": assigned_at,
    }
    conn.execute(
        "UPDATE drivers SET status = 'en_ruta', route_json = ?, assigned_at = ? WHERE id = ?",
        (json.dumps(route, ensure_ascii=False), assigned_at, driver_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"id": driver_id, "status": "en_ruta", "route": route})


@app.route("/manager/drivers/<driver_id>/complete", methods=["POST"])
def manager_complete_route(driver_id):
    conn = get_db()
    row = conn.execute("SELECT status FROM drivers WHERE id = ?", (driver_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify(error="Chofer no encontrado."), 404
    # UPDATE...WHERE status='en_ruta' + rowcount es atómico a nivel SQL: si dos pestañas
    # llaman a este endpoint casi al mismo tiempo para el mismo chofer, solo una de las dos
    # consigue actualizar la fila (SQLite serializa escrituras concurrentes), sin depender de
    # que el servidor Flask sea single-threaded (que en la práctica no siempre lo es)
    cur = conn.execute(
        "UPDATE drivers SET status = 'idle', route_json = NULL, assigned_at = NULL WHERE id = ? AND status = 'en_ruta'",
        (driver_id,),
    )
    was_en_ruta = cur.rowcount > 0
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


if __name__ == "__main__":
    app.run(port=5000, debug=True)
