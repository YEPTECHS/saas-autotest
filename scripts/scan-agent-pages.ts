import { chromium } from '@playwright/test';
import 'dotenv/config';

const BASE = process.env.YEPAI_BASE_URL!;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(BASE + '/auth/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector("input[type='email']");
await page.fill("input[type='email']", process.env.YEPAI_LOGIN_EMAIL!);
await page.fill("input[type='password']", process.env.YEPAI_LOGIN_PASSWORD!);
await page.click("button[type='submit']");
await page.waitForTimeout(4000);
console.log('Logged in, at:', page.url());

const pages = [
  { name: 'marketing-overview', url: '/ai-team/marketing' },
  { name: 'marketing-chat', url: '/ai-team/marketing/chat' },
  { name: 'marketing-studio', url: '/ai-team/marketing/studio' },
  { name: 'operation-overview', url: '/ai-team/operation' },
  { name: 'operation-chat', url: '/ai-team/operation/chat' },
];

for (const p of pages) {
  await page.goto(BASE + p.url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e: Error) => console.log('nav error:', e.message));
  await page.waitForTimeout(3000);
  const finalUrl = page.url();
  const text = (await page.evaluate(() => document.body.innerText)).slice(0, 600);
  await page.screenshot({ path: `screenshots/scan-${p.name}.png` });
  console.log(`\n=== ${p.name} ===`);
  console.log('URL:', finalUrl);
  console.log('Text:', text.replace(/\n+/g, ' | ').slice(0, 500));
}

await browser.close();
