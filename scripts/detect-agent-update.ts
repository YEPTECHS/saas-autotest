/**
 * detect-agent-update.ts — Detects changes in YepAI agent pages
 *
 * Visits each agent's chat page, extracts a fingerprint (name, role, skills),
 * compares against stored hashes, and outputs which agents changed.
 *
 * GitHub Actions outputs:
 *   changed     — comma-separated list e.g. "maya,daniel"
 *   has_changes — "true" or "false"
 */

import { chromium } from '@playwright/test';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { appendFileSync } from 'fs';
import 'dotenv/config';

const BASE_URL       = process.env.YEPAI_BASE_URL || '';
const LOGIN_EMAIL    = process.env.YEPAI_LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.YEPAI_LOGIN_PASSWORD || '';
const DATA_DIR       = join(process.cwd(), 'data');
const HASH_FILE      = join(DATA_DIR, 'agent-fingerprints.json');

const AGENTS = [
  { key: 'maya',   route: '/ai-team/marketing/chat',  label: 'Maya'   },
  { key: 'oscar',  route: '/ai-team/operation/chat',  label: 'Oscar'  },
  { key: 'daniel', route: '/ai-team/profit/chat',     label: 'Daniel' },
  { key: 'cody',   route: '/ai-team/seo/chat',        label: 'Cody'   },
];

function setOutput(name: string, value: string) {
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(ghOutput, `${name}=${value}\n`);
  } else {
    console.log(`[output] ${name}=${value}`);
  }
}

async function extractFingerprint(page: any, route: string): Promise<string> {
  try {
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const text = await page.evaluate(() => {
      const selectors = [
        'h1', 'h2', 'h3',
        '[class*="agent-name"]', '[class*="agentName"]',
        '[class*="role"]', '[class*="title"]',
        '[class*="skill"]', '[class*="capability"]',
        '[class*="description"]',
      ];
      const parts: string[] = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => {
          const t = (el as HTMLElement).innerText?.trim();
          if (t && t.length > 1 && t.length < 200) parts.push(t);
        });
      }
      return [...new Set(parts)].sort().join('|');
    });

    return createHash('md5').update(text || route).digest('hex');
  } catch {
    return createHash('md5').update(route + '_error').digest('hex');
  }
}

async function main() {
  if (!BASE_URL || !LOGIN_EMAIL || !LOGIN_PASSWORD) {
    console.error('YEPAI_BASE_URL, YEPAI_LOGIN_EMAIL, YEPAI_LOGIN_PASSWORD must be set');
    process.exit(1);
  }

  mkdirSync(DATA_DIR, { recursive: true });

  // Load stored fingerprints
  let stored: Record<string, string> = {};
  if (existsSync(HASH_FILE)) {
    try { stored = JSON.parse(readFileSync(HASH_FILE, 'utf-8')); } catch {}
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await context.newPage();

  // Login
  console.log('Logging in...');
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector("input[type='email']", { timeout: 15000 });
  await page.fill("input[type='email']", LOGIN_EMAIL);
  await page.fill("input[type='password']", LOGIN_PASSWORD);
  await page.click("button[type='submit']");
  await page.waitForURL(/dashboard|home|ai-training|analytics|customers|onboarding/, { timeout: 30000 });
  console.log('Logged in');

  // Fingerprint each agent
  const current: Record<string, string> = {};
  const changed: string[] = [];

  for (const agent of AGENTS) {
    console.log(`Checking ${agent.label}...`);
    const hash = await extractFingerprint(page, agent.route);
    current[agent.key] = hash;

    if (stored[agent.key] && stored[agent.key] !== hash) {
      console.log(`  CHANGED: ${agent.label} (${stored[agent.key].slice(0, 8)} → ${hash.slice(0, 8)})`);
      changed.push(agent.key);
    } else if (!stored[agent.key]) {
      console.log(`  NEW: ${agent.label} (first fingerprint saved)`);
    } else {
      console.log(`  unchanged: ${agent.label}`);
    }
  }

  await browser.close();

  // Save updated fingerprints
  writeFileSync(HASH_FILE, JSON.stringify(current, null, 2));

  // Set outputs
  const changedStr = changed.join(',');
  setOutput('changed', changedStr);
  setOutput('has_changes', changed.length > 0 ? 'true' : 'false');

  console.log(`\nChanged agents: ${changed.length > 0 ? changedStr : 'none'}`);

  // Exit 1 only if there's a real error (not just no changes)
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
