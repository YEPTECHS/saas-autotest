import { chromium } from '@playwright/test';
import 'dotenv/config';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

await page.goto(process.env.YEPAI_BASE_URL + '/auth/login', { waitUntil: 'domcontentloaded' });
await page.waitForSelector("input[type='email']");
await page.fill("input[type='email']", process.env.YEPAI_LOGIN_EMAIL!);
await page.fill("input[type='password']", process.env.YEPAI_LOGIN_PASSWORD!);
await page.click("button[type='submit']");
await page.waitForTimeout(5000);

console.log('Landed on:', page.url());
const text = (await page.evaluate(() => document.body.innerText)).slice(0, 400);
console.log('Content:', text);
await page.screenshot({ path: 'screenshots/home-page.png' });

await browser.close();
