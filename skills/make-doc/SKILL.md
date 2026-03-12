---
name: make-doc
description: Generate professional Word (.docx) or PDF documents. Triggers on: "genera un documento", "crea un reporte", "redacta un contrato", "haz un documento", "make a document", "write a report", "draft a contract", "genera un informe".
allowed-tools: Bash
---

# make-doc

Generate professional Word (.docx) or PDF documents from a description or outline.

## Triggers

Use when the user asks to create any kind of document: reports, contracts, proposals, letters, briefs, agreements, meeting minutes, etc.

## Workflow

1. Clarify the document type and key content if not clear (one short question max)
2. Write the full document content
3. Generate the file
4. Send it with [SEND_FILE:]

## Generate a Word (.docx) document

```python
python3 << 'EOF'
from docx import Document
from docx.shared import Pt, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
import datetime

doc = Document()

# Title
title = doc.add_heading('TITULO DEL DOCUMENTO', 0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

# Date
doc.add_paragraph(f'Fecha: {datetime.date.today().strftime("%d de %B de %Y")}')
doc.add_paragraph()

# Add sections like this:
doc.add_heading('1. Sección', level=1)
doc.add_paragraph('Contenido de la sección aquí.')

# Add a table if needed:
# table = doc.add_table(rows=1, cols=3)
# table.style = 'Table Grid'
# headers = table.rows[0].cells
# headers[0].text = 'Col 1'

OUTPUT = '/tmp/documento_{}.docx'.format(int(datetime.datetime.now().timestamp()))
doc.save(OUTPUT)
print(f'SAVED:{OUTPUT}')
EOF
```

## Generate a PDF document

```python
python3 << 'EOF'
from fpdf import FPDF
import datetime

class Doc(FPDF):
    def header(self):
        self.set_font('Helvetica', 'B', 14)
        self.cell(0, 10, 'TITULO', align='C', new_x='LMARGIN', new_y='NEXT')
        self.ln(5)
    def footer(self):
        self.set_y(-15)
        self.set_font('Helvetica', 'I', 8)
        self.cell(0, 10, f'Página {self.page_no()}', align='C')

pdf = Doc()
pdf.add_page()
pdf.set_font('Helvetica', size=11)

# Add content
pdf.set_font('Helvetica', 'B', 12)
pdf.cell(0, 8, '1. Sección', new_x='LMARGIN', new_y='NEXT')
pdf.set_font('Helvetica', size=11)
pdf.multi_cell(0, 6, 'Contenido aquí.')
pdf.ln(4)

OUTPUT = '/tmp/documento_{}.pdf'.format(int(datetime.datetime.now().timestamp()))
pdf.output(OUTPUT)
print(f'SAVED:{OUTPUT}')
EOF
```

## Send the file

```
[SEND_FILE:/tmp/documento_TIMESTAMP.docx|Aquí está tu documento]
```

## Format defaults

- Default: Word (.docx) unless user says "PDF" explicitly
- Language: Spanish unless user writes in English
- Professional tone by default, adjust per context
- Include date and author name unless told otherwise
