/**
 * Final debug: correct full flow and detect AI response class
 */
import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('https://pauck0804a.myshopify.com/', { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="password"]', '1234').catch(() => {});
  await page.click('button[type="submit"]').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(8000);

  const fl = page.frameLocator('#chatbot-widget-iframe-prod');

  // Step 1: Click bubble to open chat panel
  console.log('Step 1: Click bubble');
  await fl.locator('[data-testid="minimized-chat-button"]').click({ force: true });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'final-01-opened.png' });

  // Step 2: Fill email and click Send
  console.log('Step 2: Fill email');
  await fl.locator('input[type="email"], input[placeholder*="gmail"]').fill('test@example.com');
  await page.waitForTimeout(500);

  console.log('Step 3: Click Send button');
  await fl.locator('button:has-text("Send")').click({ force: true });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: 'final-02-in-chat.png' });

  // Check what's visible now
  const iframeEl = await page.$('#chatbot-widget-iframe-prod');
  const frame = await iframeEl?.contentFrame();
  if (!frame) { await browser.close(); return; }

  const state = await frame.evaluate(() => ({
    hasTextarea: !!document.querySelector('textarea'),
    allTexts: Array.from(document.querySelectorAll('[class]'))
      .filter(el => el.children.length === 0 && (el.textContent?.trim().length || 0) > 10)
      .map(el => ({ cls: el.className?.toString().substring(0, 60), text: el.textContent?.trim().substring(0, 80) }))
      .filter((e, i, a) => a.findIndex(x => x.text === e.text) === i)
      .slice(0, 20),
  }));
  console.log('\nState after Send:', state.hasTextarea ? 'textarea present' : 'no textarea');
  state.allTexts.forEach(t => console.log(`  class="${t.cls}" -> "${t.text}"`));

  // Step 4: Send a message
  if (state.hasTextarea) {
    console.log('\nStep 4: Sending message "What do you sell?"');
    await fl.locator('textarea').fill('What do you sell?');
    await fl.locator('textarea').press('Enter');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'final-03-message-sent.png' });

    // Poll 60s for AI response
    const snapBefore = state.allTexts.map(t => t.text || '');
    console.log('Polling for AI response...');
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(5000);
      const newEls = await frame.evaluate((prev: string[]) => {
        return Array.from(document.querySelectorAll('[class]'))
          .filter(el => el.children.length <= 1 && (el.textContent?.trim().length || 0) > 10)
          .map(el => ({ cls: el.className?.toString().substring(0, 80) || '', text: el.textContent?.trim().substring(0, 100) || '' }))
          .filter((e, idx, arr) => arr.findIndex(x => x.text === e.text) === idx)
          .filter(e => !prev.includes(e.text) && !e.text.includes('What do you sell?'));
      }, snapBefore);

      if (newEls.length > 0) {
        console.log(`\n✅ NEW CONTENT at ${i*5}s:`);
        newEls.forEach(e => console.log(`  class="${e.cls.substring(0,60)}" -> "${e.text}"`));
        await page.screenshot({ path: `final-04-response.png` });
        break;
      }
      console.log(`  ${i*5}s: waiting...`);
    }
  }

  await page.waitForTimeout(3000);
  await browser.close();
})();
