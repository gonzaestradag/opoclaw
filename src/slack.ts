import { WebClient } from '@slack/web-api';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

import { SLACK_USER_TOKEN } from './config.js';
import { saveSlackMessage } from './db.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client: WebClient | null = null;

function resolveToken(): string {
  // 1. Try env var (set at startup or dynamically via connect endpoint)
  if (SLACK_USER_TOKEN) return SLACK_USER_TOKEN;
  if (process.env['SLACK_USER_TOKEN']) return process.env['SLACK_USER_TOKEN'];

  // 2. Fall back to oauth_tokens DB
  try {
    const dbPath = path.join(__dirname, '..', 'store', 'opoclaw.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(`SELECT access_token FROM oauth_tokens WHERE provider = 'slack'`).get() as { access_token: string } | undefined;
    db.close();
    if (row?.access_token) return row.access_token;
  } catch {
    // DB not available — fall through
  }

  throw new Error('SLACK_USER_TOKEN not set. Go to Settings and connect your Slack workspace.');
}

function getClient(): WebClient {
  if (!client) {
    const token = resolveToken();
    client = new WebClient(token);
  }
  return client;
}

// Reset client when token changes (e.g., after connecting via dashboard)
export function resetSlackClient(): void {
  client = null;
}

// ── Types ───────────────────────────────────────────────────────────

export interface SlackConversation {
  id: string;
  name: string;
  isIm: boolean;
  unreadCount: number;
  lastMessage: string;
  lastMessageTs: number;
}

export interface SlackMessage {
  text: string;
  userName: string;
  fromMe: boolean;
  ts: string;
  threadTs?: string;
}

// ── User cache ──────────────────────────────────────────────────────

const userNameCache = new Map<string, string>();
let myUserId: string | null = null;

async function getMyUserId(): Promise<string> {
  if (myUserId) return myUserId;
  const web = getClient();
  const auth = await web.auth.test();
  myUserId = auth.user_id as string;
  return myUserId;
}

async function resolveUserName(userId: string): Promise<string> {
  const cached = userNameCache.get(userId);
  if (cached) return cached;

  try {
    const web = getClient();
    const info = await web.users.info({ user: userId });
    const name =
      info.user?.profile?.display_name ||
      info.user?.real_name ||
      info.user?.name ||
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

// ── Public API ──────────────────────────────────────────────────────

export async function getSlackConversations(limit = 10): Promise<SlackConversation[]> {
  const web = getClient();

  // Fetch DMs, group DMs, and channels in one call
  const result = await web.conversations.list({
    types: 'im,mpim,public_channel,private_channel',
    exclude_archived: true,
    limit: 100,
  });

  const convos = result.channels || [];
  const meId = await getMyUserId();

  const mapped: SlackConversation[] = [];

  for (const ch of convos) {
    const id = ch.id!;

    // Get display name
    let name: string;
    if (ch.is_im) {
      name = await resolveUserName(ch.user!);
    } else {
      name = ch.name || ch.name_normalized || id;
    }

    // Fetch latest message to get preview + timestamp for sorting
    let lastMessage = '';
    let lastMessageTs = 0;
    try {
      const history = await web.conversations.history({
        channel: id,
        limit: 1,
      });
      const msg = history.messages?.[0];
      if (msg) {
        lastMessage = msg.text || '';
        lastMessageTs = parseFloat(msg.ts || '0');
      }
    } catch {
      // Channel might not be accessible
      continue;
    }

    // Skip conversations with no messages
    if (!lastMessageTs) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chAny = ch as any;
    const unreadCount = chAny.unread_count ?? chAny.unread_count_display ?? 0;

    mapped.push({
      id,
      name,
      isIm: ch.is_im ?? false,
      unreadCount,
      lastMessage,
      lastMessageTs,
    });
  }

  // Sort: unread first, then by recency
  mapped.sort((a, b) => (b.unreadCount - a.unreadCount) || (b.lastMessageTs - a.lastMessageTs));

  return mapped.slice(0, limit);
}

export async function getSlackMessages(channelId: string, limit = 15): Promise<SlackMessage[]> {
  const web = getClient();
  const meId = await getMyUserId();

  const result = await web.conversations.history({
    channel: channelId,
    limit,
  });

  const messages: SlackMessage[] = [];

  for (const msg of (result.messages || []).reverse()) {
    const userId = msg.user || msg.bot_id || 'unknown';
    const fromMe = userId === meId;
    const userName = fromMe ? 'You' : await resolveUserName(userId);

    messages.push({
      text: msg.text || '',
      userName,
      fromMe,
      ts: msg.ts || '',
      threadTs: msg.thread_ts,
    });
  }

  return messages;
}

export async function sendSlackMessage(
  channelId: string,
  text: string,
  channelName: string,
  threadTs?: string,
): Promise<void> {
  const web = getClient();

  await web.chat.postMessage({
    channel: channelId,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });

  saveSlackMessage(channelId, channelName, 'You', text, String(Date.now() / 1000), true);
  logger.info({ channel: channelId }, 'Slack message sent');
}
