# Workspace

This is your local workspace — where agents save documents, reports, and files.

**This folder is in `.gitignore` — contents are never committed to GitHub.**
Your documents, reports, and files stay 100% local and private.

The install wizard copies this template to `workspace/` on first run.

---

## Folder structure

| Folder | What goes here |
|--------|----------------|
| `brain/Trading/` | Trading reports, Binance performance, bot analysis |
| `brain/Negocio/` | Business plans, strategies, proposals, client docs |
| `brain/Finanzas/` | Invoices, budgets, financial reports, expenses |
| `brain/Juntas/` | Meeting minutes, agendas, notes from recordings |
| `brain/Personal/` | Personal documents |
| `brain/Familia/` | Family-related documents |
| `brain/Documentos/` | Files uploaded via Telegram or that don't fit elsewhere |
| `brain/Varios/` | Miscellaneous |
| `uploads/` | Files sent to your assistant via Telegram |
| `reports/` | Auto-generated reports from agents |
| `meetings/` | Meeting prep and notes |
| `social/` | Social media content and schedules |
| `strategy/` | Strategy docs and roadmaps |
| `finance/` | Financial files and models |
| `content/` | Content drafts and assets |
| `memory/` | Agent memory exports |
| `intel/` | Research and intelligence reports |

---

## Brain Vault

The `brain/` folder is your Brain Vault — every document generated or uploaded
by an agent gets saved here automatically via `scripts/brain-save.sh`.

To save a file manually:
```bash
bash scripts/brain-save.sh /path/to/file.pdf "Negocio"
```
