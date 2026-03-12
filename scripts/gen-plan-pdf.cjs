#!/usr/bin/env node
// Generate isgo-business-plan.pdf from isgo-business-plan.md using Puppeteer
const puppeteer = require('/Users/opoclaw1/claudeclaw/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const WORKSPACE = '/Users/opoclaw1/claudeclaw/workspace';
const mdPath = path.join(WORKSPACE, 'isgo-business-plan.md');
const pdfPath = path.join(WORKSPACE, 'isgo-business-plan.pdf');

const md = fs.readFileSync(mdPath, 'utf-8');

// Simple markdown to HTML converter
function mdToHtml(text) {
  let html = text;

  // Escape HTML entities first
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Tables
  html = html.replace(/^\|(.+)\|\s*$/gm, (line) => {
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    return '<tr>' + cells.map(c => `<td>${c.replace(/\*\*/g, '<strong>').replace(/\*\*/g, '</strong>')}</td>`).join('') + '</tr>';
  });
  // Wrap table rows in table
  html = html.replace(/(<tr>.*<\/tr>\n?)+/gs, (block) => {
    // First row is headers if there's a separator row
    const rows = block.trim().split('\n');
    const hasSep = rows.some(r => /^<tr><td>[-:| ]+<\/td/.test(r));
    if (hasSep) {
      const headerRow = rows[0];
      const sepIdx = rows.findIndex(r => /^<tr><td>[-:| ]+<\/td/.test(r));
      const dataRows = rows.filter((_, i) => i !== 0 && i !== sepIdx);
      const headerCells = headerRow.match(/<td>(.*?)<\/td>/g) || [];
      const thead = '<thead><tr>' + headerCells.map(c => c.replace('<td>', '<th>').replace('</td>', '</th>')).join('') + '</tr></thead>';
      const tbody = '<tbody>' + dataRows.join('\n') + '</tbody>';
      return `<table>${thead}${tbody}</table>\n`;
    }
    return `<table><tbody>${block}</tbody></table>\n`;
  });

  // HR
  html = html.replace(/^---+$/gm, '<hr>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Numbered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => {
      const text = line.replace(/^\d+\. /, '');
      return `<li>${text}</li>`;
    }).join('\n');
    return `<ol>${items}</ol>\n`;
  });

  // Bullet lists
  html = html.replace(/((?:^[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(line => {
      const text = line.replace(/^[-*] /, '');
      return `<li>${text}</li>`;
    }).join('\n');
    return `<ul>${items}</ul>\n`;
  });

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Paragraphs - wrap non-empty lines that aren't already HTML
  const lines = html.split('\n');
  const result = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push('');
    } else if (trimmed.startsWith('<') || trimmed.startsWith('|')) {
      result.push(line);
    } else {
      result.push(`<p>${line}</p>`);
    }
  }
  html = result.join('\n');

  return html;
}

const body = mdToHtml(md);

const htmlContent = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #1a1a2e;
    padding: 0;
    margin: 0;
  }
  .cover {
    background: linear-gradient(135deg, #0a0f1e 0%, #0d1b2e 60%, #0a1628 100%);
    color: white;
    padding: 80px 60px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    page-break-after: always;
  }
  .cover .logo {
    font-size: 13pt;
    font-weight: 700;
    color: #14b8a6;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    margin-bottom: 48px;
    border-left: 3px solid #14b8a6;
    padding-left: 12px;
  }
  .cover h1 {
    font-size: 28pt;
    font-weight: 800;
    line-height: 1.2;
    margin-bottom: 20px;
    color: #ffffff;
  }
  .cover .subtitle {
    font-size: 14pt;
    color: rgba(255,255,255,0.65);
    margin-bottom: 60px;
  }
  .cover .meta {
    font-size: 10pt;
    color: rgba(255,255,255,0.45);
    border-top: 1px solid rgba(255,255,255,0.15);
    padding-top: 20px;
  }
  .content {
    padding: 40px 60px;
    max-width: 100%;
  }
  h1 { font-size: 20pt; font-weight: 800; color: #0a0f1e; margin: 32px 0 12px; }
  h2 {
    font-size: 14pt;
    font-weight: 700;
    color: #0a0f1e;
    margin: 28px 0 10px;
    border-bottom: 2px solid #14b8a6;
    padding-bottom: 6px;
  }
  h3 {
    font-size: 11pt;
    font-weight: 700;
    color: #0f3460;
    margin: 20px 0 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  p { margin: 6px 0 10px; color: #333; }
  strong { color: #0a0f1e; font-weight: 700; }
  ul, ol { margin: 8px 0 12px 24px; }
  li { margin-bottom: 5px; color: #444; }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
    font-size: 9.5pt;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    border-radius: 6px;
    overflow: hidden;
  }
  th {
    background: #0f3460;
    color: white;
    padding: 9px 12px;
    text-align: left;
    font-weight: 600;
    font-size: 9pt;
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid #e8e8f0;
    color: #444;
  }
  tr:nth-child(even) td { background: #f8f9fc; }
  tr:last-child td { border-bottom: none; }
  hr {
    border: none;
    border-top: 1px solid #e0e0ee;
    margin: 24px 0;
  }
  blockquote {
    border-left: 3px solid #14b8a6;
    padding: 8px 16px;
    margin: 12px 0;
    color: #555;
    font-style: italic;
    background: #f0fdfb;
  }
  .section-break { page-break-inside: avoid; }
  @page {
    margin: 15mm 20mm;
    size: A4;
  }
  @media print {
    h2 { page-break-before: auto; }
    table { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="cover">
  <div class="logo">Mindfy</div>
  <h1>Plan de Implementación</h1>
  <div class="subtitle">ISGO Manufacturing x Mindfy<br>Consultoría de Inteligencia Artificial</div>
  <div class="meta">
    Preparado por: Elon Cross, Senior Business Consultant<br>
    Fecha: Marzo 6, 2026<br>
    Clasificación: Confidencial
  </div>
</div>
<div class="content">
${body}
</div>
</body>
</html>`;

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', bottom: '15mm', left: '20mm', right: '20mm' }
    });
    console.log('PDF generated:', pdfPath);
    const stats = require('fs').statSync(pdfPath);
    console.log('File size:', stats.size, 'bytes');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
})();
