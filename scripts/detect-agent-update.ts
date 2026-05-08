/**
 * Detect per-agent UI changes on YepAI.
 * Logs in once, visits each agent's chat page, fingerprints the visible content.
 * Compares against stored fingerprints in data/agent-fingerprints.json.
 * Writes changed agent names to GITHUB_OUTPUT (or stdout).
 */

import { chromium } from '@playwright/test';
import { createHash } from 'crypto';
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const BASE_URL = process.env.YEPAI_BASE_URL || 'https://bot-test.yepai.io';
const EMAIL    = process.env.YEPAI_LOGIN_EMAIL || '';
const PASSWORD = process.env.YEPAI_LOGIN_PASSWORD || '';

const AGENTS: Record<string, string> = {
  maya:   '/ai-team/marketing/chat',
  oscar:  '/ai-team/operation/chat',
  daniel: '/ai-team/profit/chat',
};

const HASH_FILE = join(process.cwd(), 'data/agent-fingerprints.json');

async function fingerprint(page: import('@playwright/test').Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const text = await page.evaluate(() => {
    const tags = ['h1','h2','h3','p','span','div'];
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const tag of tags) {
      for (const el of Array.from(document.querySelectorAll(tag))) {
        const t = (el as HTMLElement).innerText?.trim() ?? '';
        if (t.length > 8 && t.length < 300 && !seen.has(t)) {
          seen.add(t);
          parts.push(t);
        }
      }
    }
    return parts.slice(0, 60).join('\n');
  });

  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page    = await context.newPage();

  // Login
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
  console.log('✓ Logged in');

  const stored: Record<string, string> = existsSync(HASH_FILE)
    ? JSON.parse(readFileSync(HASH_FILE, 'utf-8'))
    : {};

  const current: Record<string, string> = {};
  const changed: string[] = [];

  for (const [agent, path] of Object.entries(AGENTS)) {
    console.log(`\nChecking ${agent} (${BASE_URL}${path})...`);
    try {
      const hash = await fingerprint(page, `${BASE_URL}${path}`);
      current[agent] = hash;

      if (!stored[agent]) {
        console.log(`  📝 First run — storing hash: ${hash}`);
      } else if (stored[agent] !== hash) {
        console.log(`  ⚡ CHANGED  was=${stored[agent]}  now=${hash}`);
        changed.push(agent);
      } else {
        console.log(`  ✓ No change  hash=${hash}`);
      }
    } catch (err) {
      console.error(`  ✗ Error checking ${agent}: ${err}`);
    }
  }

  await browser.close();

  // Persist updated fingerprints
  writeFileSync(HASH_FILE, JSON.stringify({ ...stored, ...current }, null, 2));

  // Write outputs for GitHub Actions
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, `changed=${changed.join(',')}\n`);
    appendFileSync(out, `has_changes=${changed.length > 0}\n`);
  }

  if (changed.length > 0) {
    console.log(`\n🔄 Updated agents: ${changed.join(', ')}`);
  } else {
    console.log('\n✅ No agent changes detected');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
