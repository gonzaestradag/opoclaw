---
name: make-diagram
description: Generate diagrams, flowcharts, org charts, and process maps as images. Triggers on: "genera un diagrama", "crea un flowchart", "haz un organigrama", "diagrama de flujo", "make a diagram", "create a flowchart", "visualiza este proceso".
allowed-tools: Bash
---

# make-diagram

Generate visual diagrams as PNG images using Python matplotlib or graphviz.

## Triggers

Use when the user asks for any visual diagram: flowchart, org chart, process map, mind map, timeline, architecture diagram, etc.

## Method 1 — Flowchart / Process diagram (matplotlib)

```python
python3 << 'EOF'
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import datetime

fig, ax = plt.subplots(1, 1, figsize=(10, 8))
ax.set_xlim(0, 10)
ax.set_ylim(0, 10)
ax.axis('off')
fig.patch.set_facecolor('#1a1a2e')
ax.set_facecolor('#1a1a2e')

def draw_box(ax, x, y, w, h, text, color='#16213e', text_color='white', fontsize=10):
    box = FancyBboxPatch((x - w/2, y - h/2), w, h,
                          boxstyle="round,pad=0.1",
                          facecolor=color, edgecolor='#0f3460', linewidth=2)
    ax.add_patch(box)
    ax.text(x, y, text, ha='center', va='center',
            fontsize=fontsize, color=text_color, fontweight='bold', wrap=True)

def draw_arrow(ax, x1, y1, x2, y2):
    ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle='->', color='#e94560', lw=2))

# Example: customize these nodes for the actual diagram
draw_box(ax, 5, 8.5, 3, 0.8, 'INICIO', color='#0f3460')
draw_arrow(ax, 5, 8.1, 5, 7.3)
draw_box(ax, 5, 6.8, 4, 0.8, 'Paso 1', color='#16213e')
draw_arrow(ax, 5, 6.4, 5, 5.6)
draw_box(ax, 5, 5.1, 4, 0.8, 'Paso 2', color='#16213e')
draw_arrow(ax, 5, 4.7, 5, 3.9)
draw_box(ax, 5, 3.4, 3, 0.8, 'FIN', color='#0f3460')

ax.set_title('Diagrama', color='white', fontsize=14, fontweight='bold', pad=20)

OUTPUT = '/tmp/diagrama_{}.png'.format(int(datetime.datetime.now().timestamp()))
plt.tight_layout()
plt.savefig(OUTPUT, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
plt.close()
print(f'SAVED:{OUTPUT}')
EOF
```

## Method 2 — Org chart / Hierarchy

```python
python3 << 'EOF'
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import datetime

fig, ax = plt.subplots(figsize=(12, 8))
ax.axis('off')
fig.patch.set_facecolor('white')

# Define hierarchy: (label, x, y, parent_x, parent_y)
nodes = [
    ('CEO', 6, 7, None, None),
    ('CTO', 3, 5, 6, 7),
    ('CFO', 6, 5, 6, 7),
    ('COO', 9, 5, 6, 7),
    ('Dev', 2, 3, 3, 5),
    ('Infra', 4, 3, 3, 5),
]

for label, x, y, px, py in nodes:
    ax.add_patch(plt.Rectangle((x-1, y-0.4), 2, 0.8,
                                facecolor='#2C3E50', edgecolor='#ECF0F1', linewidth=1.5, zorder=2))
    ax.text(x, y, label, ha='center', va='center',
            color='white', fontsize=9, fontweight='bold', zorder=3)
    if px is not None:
        ax.annotate('', xy=(x, y+0.4), xytext=(px, py-0.4),
                   arrowprops=dict(arrowstyle='->', color='#95A5A6', lw=1.5), zorder=1)

ax.set_xlim(0, 12)
ax.set_ylim(2, 8)
ax.set_title('Organigrama', fontsize=14, fontweight='bold')

OUTPUT = '/tmp/diagrama_{}.png'.format(int(datetime.datetime.now().timestamp()))
plt.tight_layout()
plt.savefig(OUTPUT, dpi=150, bbox_inches='tight')
plt.close()
print(f'SAVED:{OUTPUT}')
EOF
```

## Send the diagram

```
[SEND_PHOTO:/tmp/diagrama_TIMESTAMP.png]
```

## Notes

- Customize the nodes/steps/structure based on what the user describes
- If matplotlib is not installed: `pip3 install matplotlib --break-system-packages`
- For complex diagrams, ask the user for the key nodes/steps before generating
