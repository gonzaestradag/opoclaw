import fs from 'fs';

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { PROJECT_ROOT } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'store', 'claudeclaw.db');

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed';
  description: string;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

function logTimeoutToDb(): void {
  try {
    const db = new Database(DB_PATH);
    db.prepare(`
      INSERT INTO agent_activity (agent_id, agent_name, agent_emoji, action, type, department, created_at)
      VALUES ('thorn', 'Thorn', '🌵', 'Agent execution timed out', 'error', 'executive', datetime('now'))
    `).run();
    db.close();
  } catch (err) {
    logger.error({ err }, 'Failed to log timeout to agent_activity');
  }
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
): Promise<AgentResult> {
  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  // Remove Claude Code env vars so the subprocess doesn't think it's nested inside another session
  delete sdkEnv['CLAUDECODE'];
  delete sdkEnv['CLAUDE_CODE_ENTRYPOINT'];
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (secrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  // 20-minute hard timeout — rejects if the agent hangs.
  // Raised from 10 min: complex delegations (multi-agent orchestration, voice + research)
  // were routinely hitting the old limit and forcing 3 retries before failing.
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Agent timeout after 20 minutes')), 20 * 60 * 1000),
  );

  const actualExecution = async (): Promise<void> => {
    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length },
      'Starting agent query',
    );

    for await (const event of query({
      prompt: singleTurn(message),
      options: {
        // cwd = claudeclaw project root so Claude Code loads our CLAUDE.md
        cwd: PROJECT_ROOT,

        // Resume the previous session for this chat (persistent context)
        resume: sessionId,

        // 'project' loads CLAUDE.md from cwd; 'user' loads ~/.claude/skills/ and user settings
        settingSources: ['project', 'user'],

        // Skip all permission prompts — this is a trusted personal bot on your own machine
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // Pass secrets to the subprocess without polluting our own process.env
        env: sdkEnv,
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        logger.info({ newSessionId }, 'Session initialized');
      }

      // Detect auto-compaction (context window was getting full)
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens },
          'Context window compacted',
        );
      }

      // Track per-call token usage from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      if (ev['type'] === 'assistant') {
        const msgUsage = (ev['message'] as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          lastCallCacheRead = callCacheRead;
        }
        if (callInputTokens > 0) {
          lastCallInputTokens = callInputTokens;
        }
      }

      // Sub-agent lifecycle events — surface to Telegram for user feedback
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
        const desc = (ev['description'] as string) ?? 'Sub-agent started';
        onProgress({ type: 'task_started', description: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
        const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
        const status = (ev['status'] as string) ?? 'completed';
        onProgress({
          type: 'task_completed',
          description: status === 'failed' ? `Failed: ${summary}` : summary,
        });
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage info from result event
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
            didCompact,
            preCompactTokens,
            lastCallCacheRead,
            lastCallInputTokens,
          };
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: ev['subtype'] },
          'Agent result received',
        );
        // Break immediately — don't wait for any trailing events the SDK
        // might yield after the result. Without this, the function hangs
        // until the 5-minute timeout fires even though we already have the answer.
        break;
      }
    }
  };

  // Errors from the claude CLI subprocess that are transient and safe to retry
  const RETRYABLE = ['exited with code 1', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'spawn', 'EPIPE'];
  const RETRY_DELAYS_MS = [2000, 5000, 10000];
  const MAX_API_RETRIES = 3;

  // Path to the tg-notify sentinel file for the current chat (if available via env).
  // Used to detect whether tg-notify.sh fired during this agent run so we can suppress
  // retries that would cause duplicate Telegram messages.
  const allowedChatId = process.env['ALLOWED_CHAT_ID'] ?? '';
  const tgNotifyFlagPath = allowedChatId ? `/tmp/opoclaw_tg_notify_sent_${allowedChatId}` : null;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    // Reset mutable state so each attempt starts clean
    newSessionId = undefined;
    resultText = null;
    lastCallCacheRead = 0;
    lastCallInputTokens = 0;
    didCompact = false;
    preCompactTokens = null;

    try {
      // Reuse the same timeout across retries — total wall time stays bounded at 10 min
      await Promise.race([actualExecution(), timeout]);
      break; // success — exit retry loop
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const isTimeout = msg.includes('timeout') || msg.includes('timed out');
      const isRetryable = !isTimeout && RETRYABLE.some(e => msg.includes(e));

      if (isRetryable && attempt < MAX_API_RETRIES) {
        // Before retrying, check if tg-notify.sh was already called during this attempt.
        // If it was, the agent already sent a message to Telegram. Retrying would cause
        // it to send again — producing duplicates. In this case, abort the retry loop and
        // return whatever resultText we have (likely null, meaning bot.ts will suppress output).
        if (tgNotifyFlagPath) {
          try {
            fs.accessSync(tgNotifyFlagPath);
            // Flag exists — tg-notify was called. Don't retry; let bot.ts suppress the output.
            logger.warn({ attempt: attempt + 1 }, 'Agent failed but tg-notify.sh was already called — skipping retry to prevent duplicate Telegram messages');
            break;
          } catch {
            // Flag not present — safe to retry
          }
        }

        const delay = RETRY_DELAYS_MS[attempt] ?? 10000;
        logger.warn({ attempt: attempt + 1, maxRetries: MAX_API_RETRIES, err: msg }, `Agent call failed (retryable), retrying in ${delay}ms`);
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        continue;
      }

      clearInterval(typingInterval);
      if (isTimeout) {
        logger.error('Agent execution timed out after 20 minutes');
        logTimeoutToDb();
      }
      throw err;
    }
  }

  clearInterval(typingInterval);
  return { text: resultText, newSessionId, usage };
}
