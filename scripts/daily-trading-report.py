#!/usr/bin/env python3
"""
Daily Trading Report — 7 PM
Generates a professional dark-theme PDF with:
- Today's P&L per bot
- All trades of the day (pair, entry, exit, result)
- Cruz Intelligence signal summary
- Strategy performance
Sends via Telegram to Gonzalo.
"""

import sqlite3
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error
import hmac
import hashlib
import time
from datetime import datetime, date
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
BASE     = Path('/Users/opoclaw1/claudeclaw')
DB_PATH  = BASE / 'store/claudeclaw.db'
ENV_PATH = BASE / '.env'
OUT_PATH = Path('/tmp/trading-report.pdf')

FT_BOTS = [
    {'name': 'Satoshi', 'port': 8081, 'user': 'satoshi', 'pass': 'opoclaw2026', 'emoji': '₿'},
    {'name': 'Nakamoto', 'port': 8082, 'user': 'nakamoto', 'pass': 'opoclaw2026', 'emoji': '🌊'},
]

# ── Load env ─────────────────────────────────────────────────────────────────
def load_env():
    env = {}
    try:
        for line in ENV_PATH.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                env[k.strip()] = v.strip().strip("'\"")
    except: pass
    return env

ENV = load_env()
BOT_TOKEN  = ENV.get('TELEGRAM_BOT_TOKEN', '')
CHAT_ID    = ENV.get('ALLOWED_CHAT_ID', '')
BINANCE_KEY    = ENV.get('BINANCE_API_KEY', '')
BINANCE_SECRET = ENV.get('BINANCE_SECRET_KEY', '')

# ── Freqtrade API ─────────────────────────────────────────────────────────────
def ft_get(bot, endpoint):
    import base64
    auth = base64.b64encode(f"{bot['user']}:{bot['pass']}".encode()).decode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{bot['port']}/api/v1/{endpoint}",
        headers={'Authorization': f'Basic {auth}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())
    except:
        return None

# ── Binance balance ───────────────────────────────────────────────────────────
def get_binance_balance():
    if not BINANCE_KEY or not BINANCE_SECRET:
        return None
    try:
        ts = int(time.time() * 1000)
        params = f'timestamp={ts}'
        sig = hmac.new(BINANCE_SECRET.encode(), params.encode(), hashlib.sha256).hexdigest()
        url = f'https://api.binance.com/api/v3/account?{params}&signature={sig}'
        req = urllib.request.Request(url, headers={'X-MBX-APIKEY': BINANCE_KEY})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
        balances = {b['asset']: float(b['free']) + float(b['locked'])
                    for b in data.get('balances', [])
                    if float(b['free']) + float(b['locked']) > 0.0001}
        return balances
    except Exception as e:
        return None

# ── Cruz signal ───────────────────────────────────────────────────────────────
def get_cruz_signal():
    try:
        return json.loads((BASE / 'store/market_signal.json').read_text())
    except:
        return {}

# ── DB trades ─────────────────────────────────────────────────────────────────
def get_today_activity():
    try:
        db = sqlite3.connect(str(DB_PATH))
        today = date.today().isoformat()
        rows = db.execute(
            "SELECT agent_name, action, type, created_at FROM agent_activity "
            "WHERE department='trading' AND date(created_at)=? ORDER BY created_at DESC LIMIT 50",
            (today,)
        ).fetchall()
        db.close()
        return rows
    except:
        return []

def get_today_intelligence():
    try:
        db = sqlite3.connect(str(DB_PATH))
        today = date.today().isoformat()
        rows = db.execute(
            "SELECT sentiment,confidence,risk_level,key_insights,news_summary,created_at "
            "FROM trading_intelligence WHERE date(created_at)=? ORDER BY created_at DESC LIMIT 3",
            (today,)
        ).fetchall()
        db.close()
        return rows
    except:
        return []

# ── Generate PDF ─────────────────────────────────────────────────────────────
def generate_pdf(bot_data, balances, cruz_signal, activity, intelligence):
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import Image as RLImage
    except ImportError:
        os.system('pip install reportlab -q')
        from reportlab.lib.pagesizes import A4
        from reportlab.lib import colors
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import cm
        from reportlab.platypus import Image as RLImage

    # Colors
    BG       = colors.HexColor('#0a0e1a')
    BG_CARD  = colors.HexColor('#111827')
    BG_ALT   = colors.HexColor('#1a2332')
    TEAL     = colors.HexColor('#0d9488')
    BLUE     = colors.HexColor('#3b82f6')
    WHITE    = colors.HexColor('#ffffff')
    TEXT     = colors.HexColor('#e2e8f0')
    MUTED    = colors.HexColor('#94a3b8')
    GREEN    = colors.HexColor('#10b981')
    RED      = colors.HexColor('#ef4444')
    YELLOW   = colors.HexColor('#f59e0b')
    BORDER   = colors.HexColor('#1e3a4a')
    PAGE_W, PAGE_H = A4

    LOGO_PATH = str(BASE / 'workspace/opoclaw-logo-hd.png')

    def header_footer(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(BG)
        canvas.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
        # Logo
        if os.path.exists(LOGO_PATH):
            canvas.drawImage(LOGO_PATH, 1.5*cm, PAGE_H-1.8*cm, width=110, height=36, preserveAspectRatio=True)
        # Header line
        canvas.setStrokeColor(TEAL)
        canvas.setLineWidth(1.5)
        canvas.line(1.5*cm, PAGE_H-2.2*cm, PAGE_W-1.5*cm, PAGE_H-2.2*cm)
        # Footer
        canvas.setFont('Helvetica', 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(1.5*cm, 0.8*cm, f'Trading Report — {datetime.now().strftime("%B %d, %Y")} | www.opoclaw.com | opoclaw@gmail.com')
        canvas.drawRightString(PAGE_W-1.5*cm, 0.8*cm, f'Page {doc.page}')
        canvas.restoreState()

    doc = SimpleDocTemplate(
        str(OUT_PATH), pagesize=A4,
        leftMargin=1.5*cm, rightMargin=1.5*cm,
        topMargin=2.8*cm, bottomMargin=1.8*cm,
        onFirstPage=header_footer, onLaterPages=header_footer
    )

    def style(size=10, color=TEXT, bold=False, align='LEFT'):
        return ParagraphStyle('s', fontSize=size, textColor=color,
            fontName='Helvetica-Bold' if bold else 'Helvetica',
            leading=size*1.4, alignment={'LEFT':0,'CENTER':1,'RIGHT':2}[align])

    story = []
    now = datetime.now()

    # Title
    story.append(Paragraph(f'TRADING REPORT — {now.strftime("%A, %B %d %Y")}', style(18, WHITE, True, 'CENTER')))
    story.append(Paragraph(f'Generated at {now.strftime("%I:%M %p")} · OpoClaw Intelligence System', style(9, MUTED, align='CENTER')))
    story.append(Spacer(1, 0.5*cm))
    story.append(HRFlowable(width='100%', thickness=1, color=TEAL))
    story.append(Spacer(1, 0.4*cm))

    # ── Cruz Signal Banner ────────────────────────────────────────────────────
    sentiment = cruz_signal.get('sentiment', 'neutral').upper()
    confidence = cruz_signal.get('confidence', 0)
    risk = cruz_signal.get('risk_level', 'medium').upper()
    fg_val = cruz_signal.get('fear_greed', {}).get('value', 50)
    fg_lbl = cruz_signal.get('fear_greed', {}).get('label', 'Neutral')

    sent_color = GREEN if sentiment == 'BULLISH' else RED if sentiment == 'BEARISH' else YELLOW
    risk_color = RED if risk == 'HIGH' else YELLOW if risk == 'MEDIUM' else GREEN

    signal_data = [
        [Paragraph('CRUZ SIGNAL', style(8, MUTED, True)),
         Paragraph('CONFIDENCE', style(8, MUTED, True)),
         Paragraph('RISK LEVEL', style(8, MUTED, True)),
         Paragraph('FEAR & GREED', style(8, MUTED, True))],
        [Paragraph(sentiment, style(14, sent_color, True, 'CENTER')),
         Paragraph(f'{confidence}%', style(14, WHITE, True, 'CENTER')),
         Paragraph(risk, style(14, risk_color, True, 'CENTER')),
         Paragraph(f'{fg_val} — {fg_lbl}', style(11, WHITE, True, 'CENTER'))],
    ]
    t = Table(signal_data, colWidths=[None]*4)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,-1), BG_CARD),
        ('BACKGROUND', (0,0), (-1,0), BG_ALT),
        ('GRID', (0,0), (-1,-1), 0.5, BORDER),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 8),
        ('BOTTOMPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(t)

    if cruz_signal.get('news_summary'):
        story.append(Spacer(1, 0.3*cm))
        story.append(Paragraph(cruz_signal['news_summary'], style(9, MUTED)))

    story.append(Spacer(1, 0.5*cm))

    # ── Binance Balance ───────────────────────────────────────────────────────
    story.append(Paragraph('PORTFOLIO BALANCE', style(11, TEAL, True)))
    story.append(HRFlowable(width='100%', thickness=0.5, color=BORDER))
    story.append(Spacer(1, 0.2*cm))

    if balances:
        usdt = balances.get('USDT', 0)
        btc  = balances.get('BTC', 0)
        bal_data = [[Paragraph('Asset', style(8, MUTED, True)), Paragraph('Balance', style(8, MUTED, True))]]
        for asset, amt in sorted(balances.items(), key=lambda x: -x[1])[:10]:
            bal_data.append([Paragraph(asset, style(9, TEXT)), Paragraph(f'{amt:.6f}', style(9, WHITE))])
        t = Table(bal_data, colWidths=[8*cm, 8*cm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), BG_ALT),
            ('BACKGROUND', (0,1), (-1,-1), BG_CARD),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [BG_CARD, BG_ALT]),
            ('GRID', (0,0), (-1,-1), 0.3, BORDER),
            ('ALIGN', (1,0), (1,-1), 'RIGHT'),
            ('TOPPADDING', (0,0), (-1,-1), 5),
            ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ]))
        story.append(t)
    else:
        story.append(Paragraph('Balance unavailable — Binance API offline or restricted', style(9, MUTED)))

    story.append(Spacer(1, 0.5*cm))

    # ── Bot Performance ───────────────────────────────────────────────────────
    story.append(Paragraph('BOT PERFORMANCE', style(11, TEAL, True)))
    story.append(HRFlowable(width='100%', thickness=0.5, color=BORDER))
    story.append(Spacer(1, 0.2*cm))

    for bot in bot_data:
        status_color = GREEN if bot.get('online') else RED
        status_txt   = 'ONLINE' if bot.get('online') else 'OFFLINE'
        pnl = bot.get('totalProfit', 0)
        pnl_color = GREEN if pnl >= 0 else RED
        win_rate = bot.get('winRate')
        wr_txt = f"{win_rate}%" if win_rate is not None else '—'

        header_data = [[
            Paragraph(f"{bot['emoji']}  {bot['name'].upper()}", style(11, WHITE, True)),
            Paragraph(status_txt, style(9, status_color, True, 'CENTER')),
            Paragraph(f'P&L: {pnl:+.4f}', style(10, pnl_color, True, 'CENTER')),
            Paragraph(f'Win Rate: {wr_txt}', style(9, TEXT, align='CENTER')),
            Paragraph(f"Trades: {bot.get('tradeCount', 0)}", style(9, TEXT, align='CENTER')),
        ]]
        t = Table(header_data, colWidths=[4.5*cm, 2.5*cm, 3.5*cm, 2.5*cm, 2*cm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,-1), BG_ALT),
            ('GRID', (0,0), (-1,-1), 0.3, BORDER),
            ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
            ('TOPPADDING', (0,0), (-1,-1), 6),
            ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ]))
        story.append(t)

        trades = bot.get('trades', [])
        if trades:
            trade_data = [[Paragraph(h, style(8, MUTED, True)) for h in ['Pair', 'Entry', 'Current', 'P&L %', 'Stake']]]
            for tr in trades:
                pct = tr.get('profitPct', 0)
                pc = GREEN if pct >= 0 else RED
                trade_data.append([
                    Paragraph(tr.get('pair','—'), style(8, TEXT)),
                    Paragraph(f"${tr.get('openRate',0):.4f}", style(8, MUTED)),
                    Paragraph(f"${tr.get('currentRate',0):.4f}", style(8, TEXT)),
                    Paragraph(f"{pct:+.2f}%", style(8, pc, True)),
                    Paragraph(f"${tr.get('stake',0):.2f}", style(8, MUTED)),
                ])
            t = Table(trade_data, colWidths=[3.5*cm, 3*cm, 3*cm, 2.5*cm, 3*cm])
            t.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), BG_CARD),
                ('ROWBACKGROUNDS', (0,1), (-1,-1), [BG_CARD, BG_ALT]),
                ('GRID', (0,0), (-1,-1), 0.3, BORDER),
                ('ALIGN', (1,0), (-1,-1), 'RIGHT'),
                ('TOPPADDING', (0,0), (-1,-1), 4),
                ('BOTTOMPADDING', (0,0), (-1,-1), 4),
            ]))
            story.append(t)
        else:
            story.append(Paragraph('  No open trades', style(8, MUTED)))

        story.append(Spacer(1, 0.3*cm))

    # ── Cruz Key Insights ─────────────────────────────────────────────────────
    insights = cruz_signal.get('key_insights', [])
    if insights:
        story.append(Spacer(1, 0.2*cm))
        story.append(Paragraph('CRUZ INTELLIGENCE — KEY INSIGHTS', style(11, TEAL, True)))
        story.append(HRFlowable(width='100%', thickness=0.5, color=BORDER))
        story.append(Spacer(1, 0.2*cm))
        for i in insights:
            story.append(Paragraph(f'• {i}', style(9, TEXT)))
            story.append(Spacer(1, 0.1*cm))
        if cruz_signal.get('satoshi_guidance'):
            story.append(Paragraph(f'Satoshi: {cruz_signal["satoshi_guidance"]}', style(9, MUTED)))
        if cruz_signal.get('nakamoto_guidance'):
            story.append(Paragraph(f'Nakamoto: {cruz_signal["nakamoto_guidance"]}', style(9, MUTED)))

    # ── Today's Activity Log ──────────────────────────────────────────────────
    if activity:
        story.append(Spacer(1, 0.4*cm))
        story.append(Paragraph('TODAY\'S TRADING ACTIVITY', style(11, TEAL, True)))
        story.append(HRFlowable(width='100%', thickness=0.5, color=BORDER))
        story.append(Spacer(1, 0.2*cm))
        act_data = [[Paragraph(h, style(8, MUTED, True)) for h in ['Time', 'Bot', 'Action']]]
        for row in activity[:20]:
            t_str = row[3].split(' ')[1][:5] if row[3] else '—'
            act_type = row[2] or 'info'
            tc = GREEN if act_type == 'success' else RED if act_type == 'error' else TEXT
            act_data.append([
                Paragraph(t_str, style(7, MUTED)),
                Paragraph(row[0], style(7, TEAL)),
                Paragraph(row[1][:90], style(7, tc)),
            ])
        t = Table(act_data, colWidths=[1.5*cm, 3*cm, 11*cm])
        t.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), BG_ALT),
            ('ROWBACKGROUNDS', (0,1), (-1,-1), [BG_CARD, BG_ALT]),
            ('GRID', (0,0), (-1,-1), 0.3, BORDER),
            ('TOPPADDING', (0,0), (-1,-1), 3),
            ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ]))
        story.append(t)

    doc.build(story)
    print(f'PDF generated: {OUT_PATH}')
    return str(OUT_PATH)


# ── Send Telegram ─────────────────────────────────────────────────────────────
def send_telegram_doc(pdf_path, bot_data, cruz_signal):
    if not BOT_TOKEN or not CHAT_ID:
        print('No Telegram credentials')
        return
    pnl_lines = []
    for b in bot_data:
        status = 'ONLINE' if b.get('online') else 'OFFLINE'
        pnl = b.get('totalProfit', 0)
        pnl_lines.append(f"{b['emoji']} {b['name']}: {status} | P&L {pnl:+.4f} | {b.get('tradeCount',0)} trades")
    sentiment = cruz_signal.get('sentiment','neutral').upper()
    fg = cruz_signal.get('fear_greed', {})
    caption = f"Trading Report — {datetime.now().strftime('%B %d, %Y')}\n\n" + '\n'.join(pnl_lines) + f"\n\nCruz: {sentiment} | F&G: {fg.get('value',50)} ({fg.get('label','?')})"
    import mimetypes
    boundary = 'boundary123456'
    with open(pdf_path, 'rb') as f:
        pdf_bytes = f.read()
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n{CHAT_ID}\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n{caption}\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="document"; filename="trading-report.pdf"\r\nContent-Type: application/pdf\r\n\r\n'
    ).encode() + pdf_bytes + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(
        f'https://api.telegram.org/bot{BOT_TOKEN}/sendDocument',
        data=body,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print('Telegram sent:', r.status)
    except Exception as e:
        print(f'Telegram error: {e}')


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print(f'[{datetime.now():%Y-%m-%d %H:%M}] Generating daily trading report...')

    # Fetch bot data
    bot_data = []
    for bot in FT_BOTS:
        status_res = ft_get(bot, 'status')
        profit_res = ft_get(bot, 'profit')
        if status_res is not None and profit_res is not None:
            open_trades = status_res if isinstance(status_res, list) else []
            bot_data.append({
                'name': bot['name'],
                'emoji': bot['emoji'],
                'online': True,
                'openTrades': len(open_trades),
                'trades': [{'pair': t.get('pair'), 'profitPct': t.get('profit_pct',0),
                            'profitAbs': t.get('profit_abs',0), 'openRate': t.get('open_rate'),
                            'currentRate': t.get('current_rate'), 'stake': t.get('stake_amount')}
                           for t in open_trades],
                'totalProfit': profit_res.get('profit_all_coin', 0),
                'tradeCount': profit_res.get('trade_count', 0),
                'winRate': round((profit_res.get('winning_trades',0) / profit_res['trade_count'] * 100), 1)
                           if profit_res.get('trade_count', 0) > 0 else None,
            })
        else:
            bot_data.append({'name': bot['name'], 'emoji': bot['emoji'], 'online': False,
                             'openTrades': 0, 'trades': [], 'totalProfit': 0, 'tradeCount': 0, 'winRate': None})

    balances  = get_binance_balance()
    cruz      = get_cruz_signal()
    activity  = get_today_activity()
    intel     = get_today_intelligence()

    print(f'Bots: {[b["name"] for b in bot_data if b["online"]]} online')
    print(f'Balances: {list(balances.keys())[:5] if balances else "unavailable"}')
    print(f'Activity rows: {len(activity)}')

    pdf = generate_pdf(bot_data, balances, cruz, activity, intel)
    send_telegram_doc(pdf, bot_data, cruz)

    # Log to DB
    try:
        db = sqlite3.connect(str(DB_PATH))
        db.execute(
            "INSERT INTO agent_activity (agent_id,agent_name,agent_emoji,action,type,department,created_at) VALUES (?,?,?,?,?,?,datetime('now'))",
            ('trading-report', 'Trading Report', '📊', 'Daily trading report PDF sent to Gonzalo', 'success', 'trading')
        )
        db.commit()
        db.close()
    except: pass

    print('Done.')

if __name__ == '__main__':
    main()
