---
name: contract-gen
description: Generate professional freelance contracts, SOWs (Statements of Work), NDAs, and service agreements. Triggers on: "draft a contract", "redacta un contrato", "NDA for", "statement of work", "acuerdo de confidencialidad", "SOW for", "service agreement", "make a contract".
allowed-tools: Bash
---

# contract-gen

Generate clean, professional legal documents. Not legal advice — templates for typical freelance/startup scenarios. Designed for Jordan (finance) and Aria (strategy) in OpoClaw.

## Document types

1. **Freelance Service Contract** — for hiring or being hired for a project
2. **NDA (Non-Disclosure Agreement)** — mutual or one-way confidentiality
3. **SOW (Statement of Work)** — scope, deliverables, timeline, payment
4. **Advisor Agreement** — equity/cash for advisory services

## Required inputs (ask if not given)

1. Document type
2. Party 1: name, company, address
3. Party 2: name, company, address
4. Key terms: scope, payment, timeline, confidentiality period (for NDA)
5. Jurisdiction (default: Mexico, laws of Mexico City)

## Generate document

```python
python3 << 'EOF'
from docx import Document
from docx.shared import Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
import datetime

doc = Document()

# Set default font
style = doc.styles["Normal"]
style.font.name = "Calibri"
style.font.size = Pt(11)

today = datetime.date.today().strftime("%B %d, %Y")

# Title — change per document type
title = doc.add_heading("NON-DISCLOSURE AGREEMENT", 0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

doc.add_paragraph(f"Effective Date: {today}")
doc.add_paragraph()

doc.add_heading("1. Parties", level=1)
doc.add_paragraph(
    "This Agreement is entered into between:\n"
    "Party A: [PARTY_A_NAME], [PARTY_A_COMPANY] ('Disclosing Party')\n"
    "Party B: [PARTY_B_NAME], [PARTY_B_COMPANY] ('Receiving Party')"
)

doc.add_heading("2. Confidential Information", level=1)
doc.add_paragraph(
    "'Confidential Information' means any data or information, oral or written, that relates to "
    "the business, technology, or operations of the Disclosing Party that is designated as confidential "
    "or that reasonably should be understood to be confidential."
)

doc.add_heading("3. Obligations", level=1)
doc.add_paragraph(
    "The Receiving Party agrees to:\n"
    "a) Keep all Confidential Information strictly confidential;\n"
    "b) Not disclose Confidential Information to any third party without prior written consent;\n"
    "c) Use Confidential Information solely for the purpose of [PURPOSE]."
)

doc.add_heading("4. Term", level=1)
doc.add_paragraph("This Agreement shall remain in effect for [DURATION] from the Effective Date.")

doc.add_heading("5. Governing Law", level=1)
doc.add_paragraph("This Agreement shall be governed by the laws of Mexico City, Mexico.")

doc.add_heading("6. Signatures", level=1)
table = doc.add_table(rows=3, cols=2)
table.style = "Table Grid"
table.cell(0,0).text = "Party A:"
table.cell(0,1).text = "Party B:"
table.cell(1,0).text = "[PARTY_A_NAME]"
table.cell(1,1).text = "[PARTY_B_NAME]"
table.cell(2,0).text = f"Date: {today}"
table.cell(2,1).text = f"Date: {today}"

OUTPUT = f"/tmp/contract-{datetime.datetime.now().strftime('%Y%m%d-%H%M')}.docx"
doc.save(OUTPUT)
print(f"SAVED:{OUTPUT}")
EOF
```

## After generating

Fill in the bracketed placeholders then send:
`[SEND_FILE:/tmp/contract-YYYYMMDD-HHMM.docx|Contract for review]`

## Log activity

```bash
sqlite3 /Users/opoclaw1/claudeclaw/store/claudeclaw.db \
  "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES ('jordan-walsh','Jordan','💰','Generated contract document','success','finance',datetime('now'))"
```
