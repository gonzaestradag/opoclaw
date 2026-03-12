---
name: agendar-reunion
description: Schedule meetings, dinners, calls, or any event on Google Calendar. Triggers on: "agendar reunion", "agenda una reunión", "programa una junta", "agenda una cena", "agendar cena", "agendar llamada", "pon en el calendario", "agenda un evento", "schedule a meeting", "block time for", "bloquea tiempo".
allowed-tools: Bash
---

# agendar-reunion

Schedule any type of event (meeting, dinner, call, lunch, etc.) on Gonzalo's Google Calendar.

## Triggers

Use this skill for any request to schedule or block time: meetings, dinners, calls, lunches, gym sessions, reminders with a time slot, or any other event.

## Step 1 — Parse the event

Extract from the user's message:
- **title**: What the event is (e.g., "Cena con amigos", "Junta con cliente", "Llamada con Rafael")
- **date**: Resolve relative dates using today's date from `currentDate` context
  - "mañana" = today + 1 day
  - "el lunes" / "next Monday" = calculate from today
  - "hoy" = today
  - Always output as YYYY-MM-DD
- **time**: Start time in 24h format (HH:MM). America/Monterrey timezone (UTC-6). Do NOT adjust.
  - "10pm" → "22:00"
  - "3:30pm" → "15:30"
  - If a range is given (e.g., "10-11pm"), extract start time and calculate duration
- **duration_min**: Duration in minutes (default: 60)
  - "10-11pm" → start: 22:00, duration: 60
  - "2-4pm" → start: 14:00, duration: 120
  - "1 hora" → 60, "30 minutos" → 30, "hora y media" → 90
  - "todo el día" / "all day" → set duration_min: 480, time: "09:00"
- **description**: Any extra context (who's attending, where, what to prepare) — optional

## Step 2 — Create the event

```bash
RESULT=$(curl -s -X POST http://localhost:3001/api/calendar/create \
  -H "Content-Type: application/json" \
  -d '{
    "title": "TITLE HERE",
    "date": "YYYY-MM-DD",
    "time": "HH:MM",
    "duration_min": 60,
    "description": "optional notes"
  }')
echo "$RESULT"
```

## Step 3 — Respond

Read the `message` field from the API response and confirm to Gonzalo in plain language.

- If `in_google: true`: "Listo. [Event] agendado el [date] a las [time]."
- If `in_google: false`: "Guardado en el calendario local, pero Google Calendar necesita reconexión. Lo puedes hacer desde el dashboard."
- Keep it short — one sentence.

## Edge cases

- **No time specified**: Ask Gonzalo what time before creating the event.
- **No date specified**: Ask which day.
- **Ambiguous duration**: Default to 60 min and confirm it in your reply.
- **Attendees mentioned** (e.g., "con Paola, con el equipo"): Include in the description field — e.g., "Asistentes: Paola, equipo de ventas". The calendar API does not send invites, so just log it.
- **Location mentioned** (e.g., "en la oficina", "en Zoom"): Include in description.

## Examples

| Input | title | date | time | duration_min |
|-------|-------|------|------|-------------|
| "Agendar cena con amigos mañana 10-11pm" | "Cena con amigos" | tomorrow | 22:00 | 60 |
| "Junta con cliente el lunes 3pm, 2 horas" | "Junta con cliente" | next Monday | 15:00 | 120 |
| "Agenda llamada con Paola el miércoles a las 11" | "Llamada con Paola" | next Wednesday | 11:00 | 60 |
| "Bloquea el viernes de 9 a 1 para trabajar" | "Trabajo profundo" | next Friday | 09:00 | 240 |
