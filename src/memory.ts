import {
  decayMemories,
  getRecentMemories,
  logAgentActivity,
  logConversationTurn,
  pruneConversationLog,
  saveMemory,
  searchMemories,
  touchMemory,
  type MemorySource,
} from './db.js';
import { logger } from './logger.js';

/**
 * Save a notable event from a non-Telegram channel into the unified memory pool.
 * Called from WhatsApp, Slack, and other channel handlers so all channels
 * contribute to the same memory that Thorn reads from.
 *
 * @param chatId    The canonical user ID (Telegram ALLOWED_CHAT_ID) used as the
 *                  unified memory key across all channels.
 * @param channel   The source channel: 'whatsapp' | 'slack' | 'phone' | etc.
 * @param direction 'in' = incoming message shown to user, 'out' = user sent a message.
 * @param contact   Contact/channel name (e.g. "Juan Pérez", "#ventas").
 * @param content   Message body to remember.
 */
export function saveChannelEvent(
  chatId: string,
  channel: MemorySource,
  direction: 'in' | 'out',
  contact: string,
  content: string,
): void {
  if (!content || content.trim().length <= 10) return;

  const trimmed = content.trim().slice(0, 400);
  const label = direction === 'in'
    ? `[${channel.toUpperCase()} from ${contact}]`
    : `[${channel.toUpperCase()} to ${contact}]`;
  const memContent = `${label}: ${trimmed}`;

  // Save as episodic memory (short-lived, decays naturally) with channel source
  saveMemory(chatId, memContent, 'episodic', undefined, channel);

  // Also log to conversation_log so /respin can surface cross-channel context
  const role = direction === 'out' ? 'assistant' : 'user';
  logConversationTurn(chatId, role, memContent, undefined, channel);
}

const SEMANTIC_SIGNALS = /\b(my|i am|i'm|i prefer|remember|always|never|quiero|siempre|nunca|prefiero|recuerda|mi |soy )\b/i;

/**
 * Build a compact memory context string to prepend to the user's message.
 * Uses 2-layer progressive disclosure:
 *   Layer 1: FTS5 keyword search against user message -> top 3 results
 *   Layer 2: Most recent 5 memories (recency)
 *   Deduplicates between layers.
 * Returns empty string if no memories exist for this chat.
 *
 * Reads from the unified memory pool — all channels (Telegram, Vapi, glasses)
 * write to the same chat_id, so context here reflects the full cross-channel history.
 */
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
): Promise<string> {
  const seen = new Set<number>();
  const lines: string[] = [];

  // Layer 1: keyword search
  const searched = searchMemories(chatId, userMessage, 3);
  for (const mem of searched) {
    seen.add(mem.id);
    touchMemory(mem.id);
    const sourceTag = mem.source && mem.source !== 'telegram' ? ` [${mem.source}]` : '';
    lines.push(`- ${mem.content} (${mem.sector}${sourceTag})`);
  }

  // Layer 2: recent memories (deduplicated)
  const recent = getRecentMemories(chatId, 5);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    touchMemory(mem.id);
    const sourceTag = mem.source && mem.source !== 'telegram' ? ` [${mem.source}]` : '';
    lines.push(`- ${mem.content} (${mem.sector}${sourceTag})`);
  }

  if (lines.length === 0) return '';

  return `[Memory context]\n${lines.join('\n')}\n[End memory context]`;
}

/**
 * Extract and save memorable facts from a conversation turn.
 * Called AFTER Claude responds, with both user message and Claude's response.
 *
 * Strategy:
 * - Save user messages containing key signals (my, I am, I prefer, remember,
 *   always, never) as 'semantic' sector (long-lived).
 * - Save other meaningful messages as 'episodic' sector (short decay).
 * - Skip short or command-like messages.
 * - Always log both user and assistant messages to conversation_log.
 *
 * @param source  Which channel this turn came from. Defaults to 'telegram'.
 *                Pass 'vapi' for phone calls, 'glasses' for AR glasses.
 */
export function saveConversationTurn(
  chatId: string,
  userMessage: string,
  claudeResponse: string,
  sessionId?: string,
  source: MemorySource = 'telegram',
): void {
  // Always log full conversation to conversation_log (for /respin)
  logConversationTurn(chatId, 'user', userMessage, sessionId, source);
  logConversationTurn(chatId, 'assistant', claudeResponse, sessionId, source);

  // Skip short or command-like messages for memory extraction
  if (userMessage.length <= 20 || userMessage.startsWith('/')) return;

  if (SEMANTIC_SIGNALS.test(userMessage)) {
    saveMemory(chatId, userMessage, 'semantic', undefined, source);
  } else {
    saveMemory(chatId, userMessage, 'episodic', undefined, source);
  }
}

/**
 * Run one decay sweep cycle: apply salience decay to memories and prune
 * old conversation_log entries. Wrapped in try/catch so a DB error does
 * not crash the interval.
 */
export function runDecaySweep(): void {
  try {
    decayMemories();
    const deleted = pruneConversationLog(500);
    if (deleted > 0) {
      logger.info({ deleted }, 'Conversation log pruned');
    }
    logAgentActivity(
      `Pruned ${deleted} memories in decay sweep`,
      'info',
    );
  } catch (err) {
    logger.error({ err }, 'Decay sweep failed');
  }
}

/**
 * Start the daily decay sweep on a 24h interval.
 * Does NOT run immediately on startup -- first sweep fires after 24h.
 * Call this once during application boot instead of calling runDecaySweep()
 * directly and pairing it with setInterval.
 */
export function initDecaySweep(): void {
  setInterval(() => runDecaySweep(), 24 * 60 * 60 * 1000);
  logger.info('Decay sweep scheduled (first run in 24h)');
}
