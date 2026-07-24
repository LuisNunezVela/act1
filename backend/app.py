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
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, jsonify, request
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

llm = ChatGoogleGenerativeAI(model="gemini-flash-latest")
chain = prompt | llm.with_structured_output(RouteQuery)
explain_chain = explain_prompt | llm | StrOutputParser()

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


if __name__ == "__main__":
    app.run(port=5000, debug=True)
