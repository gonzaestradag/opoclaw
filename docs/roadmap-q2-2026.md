# OpoClaw — Roadmap Q2 2026
**Autor:** Aria Nakamura, CSO  
**Fecha:** 1 marzo 2026  
**Período:** Abril–Junio 2026

---

## INICIATIVA 1: Capacidades Autónomas — Qué añadir primero

### Prioridad A (Abril): Autonomía de alta frecuencia y bajo riesgo

**Elias (Backend & Infra) — Deploy pipeline real**
- Conectar Elias al flow de git: puede ejecutar `git pull → npm run build → pm2 restart` en el Mac Mini sin intervención humana
- Condición: solo ejecuta deploys en ramas etiquetadas `release/*` o cuando Thorn aprueba explícitamente via `agent_approvals`
- Mecanismo ya existe: tabla `agent_approvals` + bash access. Falta: regla de rama + test de smoke post-deploy
- Entregable: Elias hace el 100% de los deploys rutinarios de OpoClaw sin que Gonzalo toque la terminal

**Silas (DevOps) — Auto-healing de servicios PM2**
- Silas monitorea PM2 cada 15 min y, si detecta un proceso caído, lo reinicia y notifica por Telegram
- Ya tiene bash + cron capability. Solo requiere un script de health check y lógica de notificación
- Entregable: cero intervención manual para reinicios de emergencia

### Prioridad B (Mayo): Reporting autónomo sin supervisión

**Jordan (CFO) — Reporte financiero semanal autónomo**
- Cada lunes 8am, Jordan consulta `llm_costs` + `token_usage`, genera análisis de gasto vs. presupuesto y lo envía vía Telegram con alerta si el ritmo supera el target mensual ($50)
- Añadir: proyección de cierre de mes y recomendación concreta (e.g. "cambiar 2 tareas de Haiku a Sonnet" o "bajar concurrencia máxima")
- Entregable: Jordan opera como CFO real — sin que Gonzalo pregunte, Jordan reporta

**Kaelen (Research) — Briefings de inteligencia automatizados**
- Kaelen produce un briefing semanal de competidores y tendencias de AI relevantes para OpoClaw, enviado los miércoles sin asignación manual de tarea
- Entregable: flujo de inteligencia continua sin dependencia de que Gonzalo cree la tarea

### Prioridad C (Junio): Coordinación multi-agente sin Thorn como intermediario

**Marcus + Lucas — Code review pipeline**
- Lucas puede abrir PRs en repo interno; Marcus revisa y comenta de forma autónoma
- Thorn solo interviene si Marcus rechaza con severidad alta
- Entregable: ciclo de código con 0 interrupciones a Gonzalo en revisiones rutinarias

---

## INICIATIVA 2: Criterios de Modelo — Sonnet vs Haiku

### Regla base (no negociable)
**Sonnet si ANY de los siguientes:**
1. El error del agente tiene consecuencias irreversibles (deploy, email enviado, dinero)
2. La tarea requiere razonamiento en cadena con más de 2 pasos de lógica condicional
3. El agente es director (Marcus, Rafael, Maya, Jordan, Sofia, Aria) — ya correcto
4. La tarea toca datos externos de terceros o integraciones OAuth

**Haiku si TODOS los siguientes:**
1. Tarea es generación/transformación de texto con instrucciones claras
2. El output puede ser revisado por un agente superior antes de actuar
3. Tarea de alta frecuencia donde el costo importa más que la perfección
4. Fallo es recuperable sin daño colateral

### Cambios concretos Q2
- **Jordan → subir a Sonnet**: maneja decisiones de gasto — el costo extra es negado por la calidad de sus análisis
- **Silas → mantener en Haiku**: scripting determinístico, no razonamiento complejo
- **Lucas → mantener en Haiku**: UI work repetitivo, revisado por Marcus antes de merge
- **Kaelen → mantener en Haiku**: volumen alto; refinamiento lo hace Rafael (Sonnet)

---

## INICIATIVA 3: Monetización y Demo a Terceros

### Decisión: no SaaS en Q2. Dos vías concretas.

**Vía 1 — OpoClaw como servicio de consultoría (Abril–Mayo)**
- Producto: instalar y configurar OpoClaw para founders/CEOs de startups latam que quieren un equipo de agentes autónomos
- Precio: $3,000–$5,000 instalación + $500/mes mantenimiento
- Entregable Q2: 2 clientes piloto. Propuesta lista en abril, cerrar en mayo
- Quien ejecuta: Aria + Sofia construyen el deck. Rafael hace targeting de prospectos
- Canal: LinkedIn outreach directo. Sofia publica 3 posts de caso de uso antes del 15 de abril

**Vía 2 — Demo público (Junio)**
- Grabar demo de 3 minutos: Elias haciendo deploy, Jordan generando reporte, Kaelen entregando briefing — sin que Gonzalo toque nada
- Publicar en LinkedIn + X. Sin landing page todavía — validar interés orgánico primero
- Si >200 comentarios o DMs en 72h: abrir waitlist. Si no: ajustar mensaje y re-intentar en Q3
- Objetivo real: deal flow de inversionistas o partnerships

### Lo que NO hacemos en Q2
- No SaaS multi-tenant: infra en Mac Mini no está lista y distrae
- No API pública: demasiado soporte, muy poco margen
- No enterprise sales: ciclo demasiado largo

---

## Métricas de éxito Q2

| Métrica | Target |
|---|---|
| Deploys autónomos por Elias | ≥10 sin intervención humana |
| Reportes financieros de Jordan | 12 semanas consecutivas |
| Costo LLM mensual | ≤$50/mes |
| Clientes piloto consultoría | 2 |
| Demo pública views | >5,000 en LinkedIn |

---

*Próxima revisión: 1 mayo 2026. Si al 30 de abril la Vía 1 no tiene prospecto activo, escalar a Vía 2 antes de tiempo.*
