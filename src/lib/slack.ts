/**
 * Shared Slack utilities
 *
 * Notification (Incoming Webhook):
 *   sendSlack(text)          — plain text message
 *   sendSlackBlocks(blocks)  — Block Kit rich message
 *
 * Interactive (Slash command reply):
 *   replyToSlack(responseUrl, text, blocks?)  — async reply to a slash command
 */

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

export async function sendSlack(text: string): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.warn(`[Slack] webhook failed: ${res.status}`);
  } catch (err) {
    console.warn('[Slack] webhook error:', err);
  }
}

export async function sendSlackBlocks(
  text: string,
  blocks: unknown[],
): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    });
    if (!res.ok) console.warn(`[Slack] webhook failed: ${res.status}`);
  } catch (err) {
    console.warn('[Slack] webhook error:', err);
  }
}

export async function replyToSlack(
  responseUrl: string,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  try {
    const body: Record<string, unknown> = {
      response_type: 'in_channel',
      text,
    };
    if (blocks?.length) body.blocks = blocks;
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn('[Slack] reply error:', err);
  }
}

// ── Block Kit helpers ──────────────────────────────────────────

export function headerBlock(text: string) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

export function sectionBlock(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

export function dividerBlock() {
  return { type: 'divider' };
}

export function contextBlock(text: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}
