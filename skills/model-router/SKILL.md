---
name: model-router
description: Automatically suggest the cheapest/fastest model for a given task to optimize OpoClaw costs. Triggers on: "qué modelo usar para", "which model for this", "cheapest model that can", "optimize model cost", "route this to cheaper model", "best model for".
allowed-tools: Bash
---

# model-router

Route tasks to the right model — balance cost vs quality. Designed for Marcus (CTO) and Jordan (finance) to keep OpoClaw under $50/month.

## OpoClaw model roster (current)

| Model | Cost | Best for |
|-------|------|---------|
| `openai/gpt-5` | Highest | APEX: complex reasoning, final decisions |
| `moonshotai/kimi-k2-0905-preview` | High | Marcus/Lucas/Elias: coding, architecture |
| `google/gemini-2.5-pro` | Medium-high | Rafael: deep research, analysis |
| `google/gemini-2.5-flash` | Low | Maya/Jordan/Silas/Kaelen: ops tasks |
| `claude-haiku-4-5` | Very low | New hires, simple tasks |
| `ollama/qwen2.5:7b` | Free | Sofia: archive, local tasks |

## Routing rules

**Use expensive models when:**
- Final customer-facing output
- Complex multi-step reasoning required
- Code that goes to production
- Decision with real consequences

**Use cheap/free models when:**
- Data formatting or transformation
- Summarizing known content
- Simple classification/routing
- Drafts that will be reviewed by a human
- Repetitive scheduled tasks

## Decision tree

```
Is this going directly to Gonzalo/customer? → Expensive model OK
Is this a draft or internal step? → Use gemini-flash
Is this data transformation only? → gemini-flash or haiku
Is this coding that goes to production? → kimi-k2
Is this research with synthesis? → gemini-pro
Is this creative writing? → kimi-k2 or claude
Is this scheduled/automated? → gemini-flash (cost priority)
```

## Monthly cost tracking

```bash
# Check Jordan's cost data
curl -s http://localhost:3001/api/kpis | python3 -c "
import sys, json
data = json.load(sys.stdin)
costs = [k for k in data if 'cost' in k.get('label','').lower()]
for c in costs: print(f\"{c['label']}: {c['value']}\")
" 2>/dev/null || echo "Check Jordan's dashboard for cost breakdown"
```

## Recommend

Given a task description, output:
```
TASK: [description]
RECOMMENDED MODEL: [model]
REASONING: [1 line why]
ESTIMATED COST: [per call or per 1k tokens]
ALTERNATIVE: [cheaper option if quality can be slightly lower]
```
