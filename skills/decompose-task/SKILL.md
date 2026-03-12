---
name: decompose-task
description: Break a complex, multi-step goal into parallel subtasks and delegate each to the right agent. Triggers on complex tasks like "vuélvete viral en Instagram", "lanza una campaña", "construye el MVP de X", "crea una estrategia completa para", or any task that would take more than 20 minutes for a single agent.
allowed-tools: Bash
---

# decompose-task

When a task is too large or complex for a single agent session, break it into concrete subtasks, assign each to the right agent, and create them all in the board. Thorn is free immediately — agents work in parallel and each notifies when done.

## When to use this

Use this skill whenever the request:
- Would take more than ~20 minutes for one agent
- Requires multiple types of expertise (research + strategy + content + execution)
- Is phrased as a high-level goal ("go viral", "launch X", "build Y")
- Previously failed with "something went wrong" or context errors

## Routing guide

| Type of work | Agent |
|---|---|
| Research, news, web search | rafael-silva |
| Strategy, planning, roadmap | aria-nakamura |
| Writing, copy, content | sofia-ramos |
| Frontend, UI, React | lucas-park |
| Backend, API, database | elias-mora |
| DevOps, PM2, scripts | silas-vane |
| Ops, scheduling, execution | maya-chen |
| Finance, costs | jordan-walsh |

## Workflow

### Step 1 — Analyze the goal
Understand the full objective. What does "done" look like? What are the distinct phases?

### Step 2 — Break into 3-7 subtasks
Each subtask must be:
- Completable by one agent in one session (~15-20 min max)
- Concrete and specific — not "research Instagram" but "find top 10 viral Instagram accounts in [niche] and analyze what makes their content work"
- Assigned to exactly one agent

### Step 3 — Create each subtask in the board

```bash
# Create each subtask via API — one curl per task
curl -s -X POST http://localhost:3001/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "[specific subtask title]",
    "description": "[clear instructions for the agent]",
    "assignee_id": "[agent-id]",
    "assignee_name": "[Agent Name]",
    "department": "[department]",
    "priority": "high",
    "status": "todo"
  }'
```

### Step 4 — Notify the user once

Send ONE message with the breakdown:
```bash
bash ${REPO_DIR}/scripts/tg-notify.sh "Meta: [goal]. Partida en [N] subtareas: [agent1] → [task1], [agent2] → [task2], etc. Te aviso cuando cada una acabe."
```

### Step 5 — Done. Thorn is free.

Do not wait for the tasks to complete. Each agent notifies individually via tg-notify.sh when their subtask is done.

## Examples

### "Vuélvete viral en Instagram y X"
1. **Rafael** → Investigar tendencias virales actuales en Instagram y X: qué formatos funcionan, qué hashtags, qué horas de publicación, ejemplos de cuentas que crecieron rápido en los últimos 3 meses
2. **Aria** → Con los hallazgos de Rafael, crear estrategia de contenido para 30 días: calendario editorial, pilares de contenido, tono y estilo, métricas objetivo
3. **Sofia** → Redactar 15 posts listos para publicar (mix de Instagram captions + X threads) siguiendo la estrategia de Aria
4. **Maya** → Investigar y configurar herramienta de scheduling (Buffer, Later, o similar), programar los primeros 7 días de contenido

### "Lanza una campaña de outreach para conseguir 10 clientes"
1. **Rafael** → Investigar ICP (Ideal Customer Profile): quiénes son, dónde están, qué problemas tienen, dónde se pueden contactar
2. **Aria** → Definir propuesta de valor, mensaje principal, y secuencia de touchpoints
3. **Sofia** → Escribir secuencia de 3 emails de cold outreach + mensaje de LinkedIn DM
4. **Maya** → Armar lista de 50 prospectos calificados con contactos verificados

### "Construye el MVP de una app de X"
1. **Aria** → Definir scope del MVP: qué features incluir, qué excluir, user stories principales
2. **Lucas** → Diseñar y construir el frontend: componentes clave, flujo principal
3. **Elias** → Construir backend: API endpoints, DB schema, auth
4. **Silas** → Deploy: configurar hosting, PM2 o similar, dominio

## Important rules

- Never assign more than one major responsibility per subtask
- Each subtask description must include all context the agent needs — don't assume they know the parent goal
- If tasks have dependencies (B needs A's output), note it in B's description: "Usa los resultados de [tarea A] como input"
- Max 7 subtasks — if it's bigger than that, decompose into phases first
