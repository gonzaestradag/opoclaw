#!/usr/bin/env python3
"""
OPO Work — Gmail Email Sender
Usage: python3 send-email.py --to "email@example.com" --subject "Subject" --body "Body text"
"""
import os
import sys
import json
import base64
import argparse
from pathlib import Path
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ['https://www.googleapis.com/auth/gmail.send']
CREDS_PATH = Path.home() / '.config/gmail/credentials.json'
TOKEN_PATH = Path.home() / '.config/gmail/token.json'

FOOTER_HTML = """
<div style="margin-top:32px;padding-top:20px;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td style="vertical-align:middle;padding-right:14px;border-right:2px solid #e5e7eb;">
        <table cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:22px;background-color:#6366f1;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:30px;background-color:#7171f3;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:16px;background-color:#8585f4;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:3px;">
              <div style="width:7px;height:36px;background-color:#9999f7;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:bottom;padding-right:10px;">
              <div style="width:7px;height:25px;background-color:#a5b4fc;border-radius:2px;"></div>
            </td>
            <td style="vertical-align:middle;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:800;letter-spacing:3px;color:#6366f1;">OPOCLAW</span>
            </td>
          </tr>
        </table>
      </td>
      <td style="padding-left:14px;vertical-align:middle;">
        <div style="font-size:13px;font-weight:600;color:#111111;margin:0;">Gonzalo Estrada</div>
        <div style="font-size:12px;color:#6b7280;margin:2px 0 0;">CEO, OpoClaw</div>
        <div style="font-size:12px;color:#6b7280;margin:4px 0 0;"><a href="mailto:opoclaw@gmail.com" style="color:#6366f1;text-decoration:none;">opoclaw@gmail.com</a> &nbsp;&middot;&nbsp; <a href="https://www.opoclaw.com" style="color:#6366f1;text-decoration:none;">www.opoclaw.com</a></div>
      </td>
    </tr>
  </table>
</div>
"""

FOOTER_PLAIN = "\n\n---\nOpoClaw | www.opoclaw.com | opoclaw@gmail.com"

def get_service():
    creds = None
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDS_PATH), SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, 'w') as token:
            token.write(creds.to_json())
    return build('gmail', 'v1', credentials=creds)

def send_email(to, subject, body, from_name="OpoClaw"):
    service = get_service()

    # Build multipart/alternative with plain text + HTML (including footer)
    msg = MIMEMultipart('alternative')
    msg['to'] = to
    msg['subject'] = subject
    msg['from'] = from_name

    plain_part = MIMEText(body + FOOTER_PLAIN, 'plain', 'utf-8')
    html_body = f"""<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111111;">
<div style="max-width:600px;padding:20px;">{body.replace(chr(10), '<br/>')}</div>
{FOOTER_HTML}
</body></html>"""
    html_part = MIMEText(html_body, 'html', 'utf-8')

    msg.attach(plain_part)
    msg.attach(html_part)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    result = service.users().messages().send(userId='me', body={'raw': raw}).execute()
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--to', required=True)
    parser.add_argument('--subject', required=True)
    parser.add_argument('--body', required=True)
    parser.add_argument('--from-name', default='OpoClaw')
    args = parser.parse_args()
    result = send_email(args.to, args.subject, args.body, args.from_name)
    print(f"Sent: {result.get('id')}")
