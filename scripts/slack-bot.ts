/**
 * slack-bot.ts — Slash command server for YepAI test automation
 *
 * Setup in Slack App dashboard:
 *   1. Create an App → Slash Commands → /yepai
 *   2. Request URL: https://your-host/slack/command
 *   3. Add SLACK_SIGNING_SECRET to .env
 *   4. Run: pnpm slack:bot
 *
 * Supported commands:
 *   /yepai help                        list all commands
 *   /yepai accuracy [maya|oscar|daniel|cody|all]
 *   /yepai triage [--days N]
 *   /yepai watch [--run-tests]
 *   /yepai status                      last report summary
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';
import { replyToSlack } from '../src/lib/slack.js';

const PORT           = parseInt(process.env.PORT || process.env.SLACK_BOT_PORT || '3100', 10);
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const REPORTS_DIR    = join(process.cwd(), 'reports');
const FLOWS_DIR      = join(process.cwd(), 'src', 'flows');

// ── Slack request verification ─────────────────────────────────

function verifySlackRequest(
  body: string,
  timestamp: string,
  signature: string,
): boolean {
  if (!SIGNING_SECRET) return true; // skip in dev if not set
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) return false; // replay attack guard

  const sigBase  = `v0:${timestamp}:${body}`;
  const expected = 'v0=' + createHmac('sha256', SIGNING_SECRET).update(sigBase).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Parse URL-encoded Slack payload ───────────────────────────

function parseBody(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw.split('&').map(pair => {
      const [k, v] = pair.split('=').map(s => decodeURIComponent(s.replace(/\+/g, ' ')));
      return [k, v];
    })
  );
}

// ── Run a pnpm command and return trimmed stdout ───────────────

function runCmd(args: string[], timeoutMs = 300_000): { out: string; ok: boolean } {
  const result = spawnSync('npx', ['tsx', ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: { ...process.env },
    cwd: process.cwd(),
  });
  const out = ((result.stdout || '') + (result.stderr || '')).trim();
  return { out, ok: result.status === 0 };
}

// ── Available flows ───────────────────────────────────────────

function getAvailableFlows(): string[] {
  if (!existsSync(FLOWS_DIR)) return [];
  return readdirSync(FLOWS_DIR)
    .filter(f => f.endsWith('.flow.yml') && !f.startsWith('_'))
    .map(f => f.replace('.flow.yml', ''))
    .sort();
}

// ── /status — last report summary ────────────────────────────

function getStatusSummary(): string {
  if (!existsSync(REPORTS_DIR)) return 'No reports found yet.';

  const agents = ['maya', 'oscar', 'daniel', 'cody'];
  const lines: string[] = [];

  for (const agent of agents) {
    const files = readdirSync(REPORTS_DIR)
      .filter(f => f.startsWith(`${agent}-accuracy`) && f.endsWith('.json'))
      .sort().reverse();
    if (!files.length) { lines.push(`${agent.toUpperCase()}: no report`); continue; }
    try {
      const data = JSON.parse(readFileSync(join(REPORTS_DIR, files[0]), 'utf-8')) as {
        successRate: number; passed: number; evaluatedCases: number; generatedAt: string;
      };
      const date = data.generatedAt?.slice(0, 10) || '?';
      const icon = data.successRate >= 80 ? '✅' : data.successRate >= 60 ? '⚠️' : '❌';
      lines.push(`${icon} *${agent.toUpperCase()}*: ${data.successRate.toFixed(1)}% (${data.passed}/${data.evaluatedCases}) — ${date}`);
    } catch {
      lines.push(`${agent.toUpperCase()}: unreadable report`);
    }
  }

  // Triage summary
  const triageFiles = readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith('triage-') && f.endsWith('.json'))
    .sort().reverse();
  if (triageFiles.length) {
    try {
      const t = JSON.parse(readFileSync(join(REPORTS_DIR, triageFiles[0]), 'utf-8')) as {
        byClass: { BUG: number; FLAKY: number; ENV: number }; generatedAt: string;
      };
      lines.push(`\n🔎 *Triage* (${t.generatedAt?.slice(0, 10)}): 🐛 BUG ${t.byClass.BUG} | 🌊 FLAKY ${t.byClass.FLAKY} | ⚙️ ENV ${t.byClass.ENV}`);
    } catch { /* ignore */ }
  }

  return lines.join('\n');
}

// ── Command dispatcher ─────────────────────────────────────────

async function handleCommand(text: string, responseUrl: string): Promise<void> {
  const parts  = text.trim().split(/\s+/);
  const cmd    = parts[0]?.toLowerCase() || 'help';
  const rest   = parts.slice(1);

  switch (cmd) {
    case 'help': {
      await replyToSlack(responseUrl, [
        '*YepAI Test Bot — available commands:*',
        '`/yepai accuracy [maya|oscar|daniel|cody|all]` — run accuracy tests',
        '`/yepai alert` — check accuracy thresholds and alert if below 80%',
        '`/yepai repair [flow-name|--all]` — auto-fix broken flows',
        '`/yepai flow list` — list all available flows',
        '`/yepai flow <name>` — run a specific flow',
        '`/yepai triage [--days N]` — classify recent test failures',
        '`/yepai watch [--run-tests]` — detect agent UI changes',
        '`/yepai status` — show last report summary',
        '`/yepai help` — show this message',
      ].join('\n'));
      break;
    }

    case 'status': {
      await replyToSlack(responseUrl, getStatusSummary());
      break;
    }

    case 'accuracy': {
      const agent = rest[0] || 'all';
      const valid = ['maya', 'oscar', 'daniel', 'cody', 'all'];
      if (!valid.includes(agent)) {
        await replyToSlack(responseUrl, `Unknown agent: \`${agent}\`. Use: ${valid.join(', ')}`);
        break;
      }
      await replyToSlack(responseUrl, `⏳ Running accuracy tests for *${agent}*… (this may take a few minutes)`);
      const { out, ok } = runCmd(['scripts/accuracy-test-api.ts', '--agent', agent]);
      const lines = out.split('\n').filter(l => /RESULTS|PASS|FAIL|passed|✅|❌|⚠/.test(l)).slice(0, 20);
      await replyToSlack(responseUrl, ok
        ? `✅ *accuracy:${agent}* done\n\`\`\`${lines.join('\n')}\`\`\``
        : `❌ *accuracy:${agent}* failed\n\`\`\`${lines.join('\n')}\`\`\``
      );
      break;
    }

    case 'triage': {
      const days = rest.find(r => /^\d+$/.test(r)) || '1';
      await replyToSlack(responseUrl, `⏳ Running triage (last ${days} day(s))…`);
      const { out, ok } = runCmd(['scripts/triage-agent.ts', '--days', days]);
      const lines = out.split('\n')
        .filter(l => /BUG|FLAKY|ENV|Summary|TRIAGE|🐛|🌊|⚙/.test(l))
        .slice(0, 20);
      await replyToSlack(responseUrl, ok
        ? `🔎 *Triage* done\n\`\`\`${lines.join('\n')}\`\`\``
        : `❌ *Triage* failed\n\`\`\`${out.slice(0, 800)}\`\`\``
      );
      break;
    }

    case 'watch': {
      const runTests = rest.includes('--run-tests');
      await replyToSlack(responseUrl, `⏳ Running change watch${runTests ? ' + accuracy tests' : ''}…`);
      const args = ['scripts/change-watch-agent.ts'];
      if (runTests) args.push('--run-tests');
      const { out, ok } = runCmd(args, 600_000);
      const lines = out.split('\n')
        .filter(l => /REGRESSION|IMPROVEMENT|NEUTRAL|CHANGED|No agent/.test(l))
        .slice(0, 15);
      await replyToSlack(responseUrl, ok
        ? `👁 *Change watch* done\n\`\`\`${lines.join('\n') || 'No changes detected'}\`\`\``
        : `❌ *Change watch* failed\n\`\`\`${out.slice(0, 800)}\`\`\``
      );
      break;
    }

    case 'repair': {
      const target = rest[0] || '--all';
      await replyToSlack(responseUrl, `⏳ 正在运行 repair-agent (${target})…（可能需要几分钟）`);
      const args = ['scripts/repair-agent.ts'];
      if (target === '--all') {
        args.push('--all');
      } else {
        args.push(target);
      }
      const { out, ok } = runCmd(args, 600_000);
      const lines = out.split('\n')
        .filter(l => /fixed|FIXED|repair|FAIL|PASS|patched|✅|❌/.test(l))
        .slice(0, 20);
      await replyToSlack(responseUrl, ok
        ? `🔧 *Repair* 完成\n\`\`\`${lines.join('\n') || 'No failed flows found'}\`\`\``
        : `❌ *Repair* 失败\n\`\`\`${out.slice(0, 800)}\`\`\``
      );
      break;
    }

    case 'alert': {
      await replyToSlack(responseUrl, `⏳ 检查准确率阈值…`);
      const { out } = runCmd(['scripts/alert-agent.ts'], 60_000);
      await replyToSlack(responseUrl, `\`\`\`${out.slice(0, 800)}\`\`\``);
      break;
    }

    case 'flow': {
      const sub = rest[0]?.toLowerCase();

      if (!sub || sub === 'list') {
        const flows = getAvailableFlows();
        await replyToSlack(responseUrl,
          `*Available flows (${flows.length}):*\n\`\`\`${flows.join('\n')}\`\`\`\n使用: \`/yepai flow <name>\``
        );
        break;
      }

      const flows = getAvailableFlows();
      if (!flows.includes(sub)) {
        await replyToSlack(responseUrl,
          `❌ 找不到 flow: \`${sub}\`\n用 \`/yepai flow list\` 查看所有可用 flow`
        );
        break;
      }

      await replyToSlack(responseUrl, `⏳ 正在运行 flow: *${sub}*…`);
      const { out, ok } = runCmd(['src/cli/index.ts', 'run', sub], 300_000);
      const lines = out.split('\n')
        .filter(l => /PASS|FAIL|SKIP|Flow|Step|✅|❌|⚠/.test(l))
        .slice(0, 25);
      await replyToSlack(responseUrl, ok
        ? `✅ *flow:${sub}* 完成\n\`\`\`${lines.join('\n') || out.slice(0, 500)}\`\`\``
        : `❌ *flow:${sub}* 失败\n\`\`\`${lines.join('\n') || out.slice(0, 500)}\`\`\``
      );
      break;
    }

    default: {
      await replyToSlack(responseUrl, `Unknown command: \`${cmd}\`. Try \`/yepai help\``);
    }
  }
}

// ── HTTP server ────────────────────────────────────────────────

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST' || req.url !== '/slack/command') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody  = Buffer.concat(chunks).toString('utf-8');
    const timestamp = req.headers['x-slack-request-timestamp'] as string || '';
    const signature = req.headers['x-slack-signature'] as string || '';

    if (!verifySlackRequest(rawBody, timestamp, signature)) {
      res.writeHead(401);
      res.end('Unauthorized');
      return;
    }

    const payload      = parseBody(rawBody);
    const text         = payload['text'] || '';
    const responseUrl  = payload['response_url'] || '';
    const userName     = payload['user_name'] || 'unknown';

    console.log(`[${new Date().toISOString()}] /yepai ${text} (from @${userName})`);

    // Acknowledge immediately (Slack requires response within 3s)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response_type: 'ephemeral', text: `⏳ Running \`/yepai ${text || 'help'}\`…` }));

    // Handle asynchronously
    handleCommand(text, responseUrl).catch(err =>
      replyToSlack(responseUrl, `❌ Internal error: ${err.message}`)
    );
  });
});

server.listen(PORT, () => {
  console.log(`\n🤖 YepAI Slack bot running on port ${PORT}`);
  console.log(`   Endpoint: POST http://localhost:${PORT}/slack/command`);
  if (!SIGNING_SECRET) console.warn('   ⚠️  SLACK_SIGNING_SECRET not set — request verification disabled');
  console.log('\n   Commands: /yepai [help|accuracy|triage|watch|status]\n');
});
