# Manual de uso — EasyRoute

Aplicación de dos páginas para modelar el problema de reparto en Santa Cruz como grafo y comparar los algoritmos BFS y DFS. Se navega entre ellas con los botones 🗺 Demo / ✏️ Editor ubicados debajo del panel izquierdo.

## 1. editor.html — Construcción del grafo

En esta página se crean los nodos (intersecciones o puntos de referencia) y las calles (aristas), trazándolos manualmente sobre el mapa real.

Modos disponibles (botones en la parte superior del panel):

🖐 Mover Permite navegar el mapa (zoom y desplazamiento) sin agregar elementos.
📍 Punto  Cada clic sobre el mapa crea un nuevo nodo. Se solicita un nombre (por ejemplo, "Radial 10 x 2do Anillo"); si se cancela, el nodo no se crea.
〰 Línea  Traza una calle entre dos nodos. Se hace clic en un nodo de origen; cada clic siguiente sobre el mapa agrega un punto intermedio (para seguir la curva real de la calle); un clic sobre otro nodo finaliza el trazo. Un clic nuevamente sobre el nodo de origen cancela el trazo.
🗑 Borrar  Un clic sobre un nodo o una calle la elimina. Si el nodo tiene calles conectadas, se solicita confirmación para eliminar todo en conjunto

Otros controles:
- ↩ Deshacer último: revierte la última acción realizada (creación de nodo o calle).
- 🗑 Limpiar todo: elimina todo el grafo (solicita confirmación).
- Opacidad del mapa: control deslizante que aclara u oscurece el mapa base para resaltar mejor los nodos y las calles.
- Lista de nodos (parte inferior del panel): permite renombrar cualquier nodo escribiendo directamente en la lista.
- El trabajo se guarda automáticamente en el navegador (localStorage) mientras se edita; al cerrar y volver a abrir la página, el progreso se conserva.

Guardar y cargar:
- 💾 Guardar archivo: descarga manual_graph.json con el grafo completo.
- 📂 Cargar archivo: reemplaza el grafo actual por el contenido de un archivo .json seleccionado.

## 2. Sincronización del grafo con la demostración (paso obligatorio)

La página de demostración no lee el editor en tiempo real; utiliza archivos generados por el notebook. Cada vez que se modifique el grafo en el editor, es necesario:

1. Hacer clic en 💾 Guardar archivo para descargar manual_graph.json.
2. Colocar ese archivo en la carpeta data/ del proyecto, reemplazando el existente.
3. Ejecutar el notebook para regenerar los datos:
cd notebook
..\.venv\Scripts\jupyter nbconvert --to notebook --execute --inplace reparto_santa_cruz.ipynb
4. Recién entonces index.html mostrará el grafo actualizado.

## 3. index.html — Demostración y animación de BFS vs DFS

- Origen y destino: se seleccionan haciendo clic en dos nodos del mapa (el primer clic define el origen, el segundo el destino). El botón Usar ruta por defecto carga automáticamente el par Depósito → Cliente Ejemplo. El botón Limpiar selección reinicia la selección.
- Algoritmo a animar: se elige entre BFS o DFS mediante el selector correspondiente.
- ▶ Play / ⏸ Pausa / ⟲ Reiniciar: controlan la animación paso a paso del recorrido del algoritmo seleccionado.
- Velocidad: control deslizante que ajusta los milisegundos entre cada paso de la animación; puede modificarse incluso durante la reproducción.
- Opacidad del mapa: cumple la misma función que en el editor, resaltando nodos y aristas sobre el fondo del mapa.
- Progreso: indicador de tipo "Paso X / Y" que muestra el avance del recorrido actual.
- Leyenda de colores:
  - Gris: nodo no visitado.
  - Amarillo: nodo en frontera (c
  - Rojo: nodo actual o inicio del camino final.
  - Dorado: fin del camino.
  - Verde: camino final (nodos intermedios).
  - Morado: nodos con rol fijo (Depósito o Cliente).
- Etiquetas sobre las calles: cada arista muestra su costo en kilómetros en el punto medio del trazo real.
- Tabla comparativa (parte inferior del panel): presenta nodos explorados, costo del camino, tiempo de ejecución y longitud del camino para BFS y DFS del par seleccionado, resaltando en verde el algoritmo con mejor resultado en cada métrica.

## 4. Flujo de trabajo recomendado

1. Abrir editor.html y trazar los nodos y calles sobre el mapa real.
2. Guardar el archivo y reemplazarlo en data/manual_graph.json.
3. Ejecutar el notebook para regenerar data/graph_export.json y viz/graph_data.js.
4. Abrir index.html, seleccionar origen y destino (o usar la ruta por defecto), elegir el algoritmo y presionar Play para observar la animación y comparar las métricas.
