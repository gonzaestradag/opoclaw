---
name: expense-report
description: Generate expense reports, track spending by category, and alert on budget overruns. Triggers on: "expense report", "reporte de gastos", "cuánto gastamos en", "track expenses", "budget report", "spending breakdown", "breakdown de costos", "cuánto nos costó".
allowed-tools: Bash
---

# expense-report

Track expenses and generate reports. Designed for Jordan (finance) in OpoClaw. Target: keep total monthly costs under $50.

## Quick expense log

```bash
# Log a new expense
DATE=$(date +%Y-%m-%d)
cat >> ${REPO_DIR}/workspace/expenses.csv << EOF
$DATE,[CATEGORY],[DESCRIPTION],[AMOUNT_USD],[VENDOR]
EOF
echo "Expense logged"
```

Categories: `ai-api`, `infrastructure`, `tools`, `marketing`, `misc`

## View current month spending

```bash
MONTH=$(date +%Y-%m)
echo "=== Expenses for $MONTH ==="
grep "^$MONTH" ${REPO_DIR}/workspace/expenses.csv 2>/dev/null | \
  awk -F',' '{sum+=$4; print $3, "$"$4} END {print "TOTAL: $"sum}'
```

## Generate Excel report

```python
python3 << 'EOF'
import csv, datetime
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

wb = Workbook()
ws = wb.active
ws.title = "Expenses"

# Headers
headers = ["Date", "Category", "Description", "Amount (USD)", "Vendor"]
for col, header in enumerate(headers, 1):
    cell = ws.cell(row=1, column=col, value=header)
    cell.font = Font(bold=True, color="FFFFFF")
    cell.fill = PatternFill("solid", fgColor="1a1a2e")
    cell.alignment = Alignment(horizontal="center")

# Load data
try:
    with open("${REPO_DIR}/workspace/expenses.csv") as f:
        reader = csv.reader(f)
        for row_num, row in enumerate(reader, 2):
            for col, val in enumerate(row, 1):
                ws.cell(row=row_num, column=col, value=val)
except FileNotFoundError:
    ws.cell(row=2, column=1, value="No expenses logged yet")

# Auto-width columns
for col in range(1, 6):
    ws.column_dimensions[get_column_letter(col)].auto_size = True

OUTPUT = f"/tmp/expense-report-{datetime.date.today().strftime('%Y-%m')}.xlsx"
wb.save(OUTPUT)
print(f"SAVED:{OUTPUT}")
EOF
```

## Budget alerts

```bash
# Check if over $50/month
MONTH=$(date +%Y-%m)
TOTAL=$(grep "^$MONTH" ${REPO_DIR}/workspace/expenses.csv 2>/dev/null | awk -F',' '{sum+=$4} END {print sum+0}')
BUDGET=50
if (( $(echo "$TOTAL > $BUDGET" | bc -l) )); then
  echo "ALERT: Over budget! Spent $TOTAL of $BUDGET"
  bash ${REPO_DIR}/scripts/tg-notify.sh "Jordan: budget alert — gastamos $${TOTAL} de $${BUDGET} este mes"
else
  echo "On track: $TOTAL / $BUDGET"
fi
```

## Log to Jordan's activity

```bash
sqlite3 ${REPO_DIR}/store/opoclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('jordan-walsh','Jordan','💰','Generated expense report','success','finance',datetime('now'))"
```
