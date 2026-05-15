import { chromium } from 'playwright';

const BASE_URL = 'https://bot-test.yepai.io';
const EMAIL = 'yuy0311+03092025@gmail.com';
const PASSWORD = 'Abcd1234!';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.goto(`${BASE_URL}/login`);
await page.waitForSelector('input[type="email"]');
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForTimeout(5000);

const links = await page.evaluate(() => {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  return [...new Set(anchors.map(a => a.getAttribute('href')))].filter(h => h && h.startsWith('/'));
});

const navText = await page.evaluate(() => {
  const nav = document.querySelector('nav, aside, [class*="sidebar"], [class*="Sidebar"]');
  return nav ? nav.innerText : '';
});

console.log('=== LINKS FOUND ===');
console.log(JSON.stringify(links, null, 2));
console.log('\n=== NAV TEXT ===');
console.log(navText);

await browser.close();
