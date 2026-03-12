---
name: invoice-gen
description: Generate professional PDF invoices for clients. Triggers on: "genera una factura", "crea un invoice", "bill the client", "invoice for", "factura para", "make an invoice", "send invoice to".
allowed-tools: Bash
---

# invoice-gen

Generate clean, professional PDF invoices. Designed for Jordan (finance) in OpoClaw.

## Triggers

Use when a client needs to be billed, a receipt generated, or a payment request created.

## Required inputs (ask if not given)

1. Client name and email
2. Line items (description + quantity + price)
3. Currency (USD / MXN / EUR)
4. Due date (default: 15 days from today)
5. Invoice number (auto-generate if not given)

## Generate PDF invoice

```python
python3 << 'EOF'
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
import datetime, os

# CONFIG — fill these in
CLIENT_NAME = "CLIENT_NAME_HERE"
CLIENT_EMAIL = "client@email.com"
LINE_ITEMS = [
    ("Service description", 1, 5000.00),
    # ("Another item", 2, 250.00),
]
CURRENCY = "USD"
INVOICE_NUM = f"INV-{datetime.datetime.now().strftime('%Y%m%d-%H%M')}"
DUE_DAYS = 15
COMPANY = "YOUR_COMPANY_NAME"

# Calculate
subtotal = sum(qty * price for _, qty, price in LINE_ITEMS)
due_date = (datetime.date.today() + datetime.timedelta(days=DUE_DAYS)).strftime("%B %d, %Y")
today = datetime.date.today().strftime("%B %d, %Y")

OUTPUT = f"/tmp/invoice-{INVOICE_NUM}.pdf"
doc = SimpleDocTemplate(OUTPUT, pagesize=letter, rightMargin=72, leftMargin=72, topMargin=72, bottomMargin=72)
styles = getSampleStyleSheet()

story = []

# Header
story.append(Paragraph(f"<b>INVOICE</b>", ParagraphStyle("title", fontSize=28, spaceAfter=4)))
story.append(Paragraph(f"<b>{COMPANY}</b>", styles["Normal"]))
story.append(Spacer(1, 0.3*inch))

# Meta
meta_data = [
    ["Invoice #:", INVOICE_NUM, "Date:", today],
    ["Bill To:", CLIENT_NAME, "Due:", due_date],
    ["", CLIENT_EMAIL, "", ""],
]
meta_table = Table(meta_data, colWidths=[1.2*inch, 2.3*inch, 1*inch, 2*inch])
meta_table.setStyle(TableStyle([
    ("FONTNAME", (0,0), (0,-1), "Helvetica-Bold"),
    ("FONTNAME", (2,0), (2,-1), "Helvetica-Bold"),
    ("FONTSIZE", (0,0), (-1,-1), 10),
    ("BOTTOMPADDING", (0,0), (-1,-1), 6),
]))
story.append(meta_table)
story.append(Spacer(1, 0.4*inch))

# Line items table
headers = ["Description", "Qty", "Unit Price", "Total"]
rows = [headers]
for desc, qty, price in LINE_ITEMS:
    rows.append([desc, str(qty), f"{CURRENCY} {price:,.2f}", f"{CURRENCY} {qty*price:,.2f}"])
rows.append(["", "", "TOTAL DUE", f"{CURRENCY} {subtotal:,.2f}"])

items_table = Table(rows, colWidths=[3.5*inch, 0.7*inch, 1.5*inch, 1.5*inch])
items_table.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#1a1a2e")),
    ("TEXTCOLOR", (0,0), (-1,0), colors.white),
    ("FONTNAME", (0,0), (-1,0), "Helvetica-Bold"),
    ("FONTNAME", (0,-1), (-1,-1), "Helvetica-Bold"),
    ("FONTSIZE", (0,0), (-1,-1), 10),
    ("ROWBACKGROUNDS", (0,1), (-1,-2), [colors.white, colors.HexColor("#f8f8f8")]),
    ("GRID", (0,0), (-1,-2), 0.5, colors.HexColor("#cccccc")),
    ("LINEABOVE", (0,-1), (-1,-1), 1.5, colors.HexColor("#1a1a2e")),
    ("ALIGN", (1,0), (-1,-1), "RIGHT"),
    ("TOPPADDING", (0,0), (-1,-1), 8),
    ("BOTTOMPADDING", (0,0), (-1,-1), 8),
]))
story.append(items_table)
story.append(Spacer(1, 0.5*inch))
story.append(Paragraph("Thank you for your business.", styles["Normal"]))

doc.build(story)
print(f"SAVED:{OUTPUT}")
EOF
```

## After generating

Send via: `[SEND_FILE:/tmp/invoice-{INVOICE_NUM}.pdf|Invoice {INVOICE_NUM} for {CLIENT_NAME}]`

## Log to Jordan's activity

```bash
sqlite3 ${REPO_DIR}/store/opoclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('jordan-walsh','Jordan','💰','Generated invoice for client','success','finance',datetime('now'))"
```
