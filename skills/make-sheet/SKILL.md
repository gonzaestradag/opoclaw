---
name: make-sheet
description: Generate Excel (.xlsx) or CSV spreadsheets. Triggers on: "genera un excel", "crea una hoja de cálculo", "haz una tabla en excel", "make a spreadsheet", "create an excel", "genera una tabla", "necesito un excel con".
allowed-tools: Bash
---

# make-sheet

Generate Excel or CSV files from a description, data, or structure.

## Triggers

Use when the user asks for any spreadsheet, table, tracker, budget, roster, or data file.

## Workflow

1. Understand what columns and data are needed
2. Generate the file with proper formatting
3. Send it

## Generate Excel (.xlsx)

```python
python3 << 'EOF'
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
import datetime

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "Hoja 1"

# Header style
header_fill = PatternFill(start_color="2C3E50", end_color="2C3E50", fill_type="solid")
header_font = Font(color="FFFFFF", bold=True, size=11)
header_align = Alignment(horizontal='center', vertical='center')

# Define headers
headers = ['Columna 1', 'Columna 2', 'Columna 3']
for col_num, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col_num, value=header)
    cell.font = header_font
    cell.fill = header_fill
    cell.alignment = header_align
    ws.column_dimensions[get_column_letter(col_num)].width = 20

ws.row_dimensions[1].height = 25

# Add data rows
data = [
    ['Dato 1', 'Dato 2', 100],
    ['Dato 3', 'Dato 4', 200],
]
for row_data in data:
    ws.append(row_data)

# Freeze header row
ws.freeze_panes = 'A2'

OUTPUT = '/tmp/tabla_{}.xlsx'.format(int(datetime.datetime.now().timestamp()))
wb.save(OUTPUT)
print(f'SAVED:{OUTPUT}')
EOF
```

## Generate CSV

```python
python3 << 'EOF'
import csv, datetime

OUTPUT = '/tmp/tabla_{}.csv'.format(int(datetime.datetime.now().timestamp()))
with open(OUTPUT, 'w', newline='', encoding='utf-8-sig') as f:
    writer = csv.writer(f)
    writer.writerow(['Columna 1', 'Columna 2', 'Columna 3'])
    writer.writerows([
        ['Dato 1', 'Dato 2', 100],
    ])
print(f'SAVED:{OUTPUT}')
EOF
```

## Send the file

```
[SEND_FILE:/tmp/tabla_TIMESTAMP.xlsx|Aquí está tu tabla]
```

## Defaults

- Default: Excel (.xlsx) — more professional than CSV
- Include header row with dark background always
- Freeze top row always
- Auto-fit column widths
- Use Spanish headers unless user specifies otherwise
