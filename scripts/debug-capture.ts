/**
 * Debug: login as hemopiv218, capture API call, send one request, print full response.
 */
import { chromium } from '@playwright/test';
import 'dotenv/config';

const BASE_URL = process.env.YEPAI_BASE_URL || 'https://app.yepai.ai';
const AGENT_ARG = process.argv[process.argv.indexOf('--agent') + 1] || 'maya';
const USER_ARG  = process.argv[process.argv.indexOf('--user')  + 1] || 'hemopiv218@auslank.com';

const AGENT_PATHS: Record<string,string> = {
  maya:   '/ai-team/marketing/chat',
  oscar:  '/ai-team/operation/chat',
  daniel: '/ai-team/profit/chat',
  cody:   '/ai-team/seo/chat',
};

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

(async () => {
  console.log(`\n=== Debug Capture for ${USER_ARG} / agent=${AGENT_ARG} ===`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  let endpoint = '';
  let capturedHeaders: Record<string,string> = {};
  let bodyTemplate: Record<string,unknown> = {};

  const EXCLUDED = ['/auth/', '/login', '/register', '/logout', '/signup', '/token', '/refresh'];

  const startListening = () => {
    page.on('request', req => {
      if (endpoint) return;
      const url = req.url();
      if (req.method() !== 'POST') return;
      if (EXCLUDED.some(ex => url.toLowerCase().includes(ex))) return;
      const h = req.headers();
      let body: Record<string,unknown> = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch { /* ignore */ }
      const hasMsgField = Object.keys(body).some(k =>
        ['message','content','text','query','input','prompt','userMessage','msg','messages'].includes(k)
      );
      const isChatUrl = url.includes('/chat') || url.includes('/message') || url.includes('/conversation') ||
        url.includes('/stream') || url.includes('/send') || url.includes('/query') ||
        url.includes('/ask') || url.includes('/completions') || url.includes('/v1/') || url.includes('/api/');
      if (!hasMsgField && !isChatUrl) return;

      endpoint = url;
      capturedHeaders = { ...h };
      bodyTemplate = body;
      console.log(`\n[CAPTURED] URL: ${url}`);
      console.log('[CAPTURED] Body keys:', Object.keys(body).join(', '));
      console.log('[CAPTURED] Body (truncated):', JSON.stringify(body).substring(0, 500));
    });
  };

  try {
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
    await page.fill('input[type="email"], input[name="email"]', USER_ARG);
    await page.fill('input[type="password"], input[name="password"]', 'Asdf@1234');
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|home|ai-training|analytics|onboarding/, { timeout: 30000 });
    console.log('[LOGIN] Success, current URL:', page.url());

    startListening();
    await page.goto(`${BASE_URL}${AGENT_PATHS[AGENT_ARG]}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Send probe
    const probe = 'What color scheme works best for a luxury fashion brand?';
    await page.evaluate((text: string) => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement;
      if (!ta) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(ta, text); else ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
    }, probe);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const ta = document.querySelector('textarea');
      if (!ta) return;
      const btn = ta.parentElement?.querySelector('button') || ta.parentElement?.parentElement?.querySelector('button');
      if (btn) (btn as HTMLButtonElement).click();
    });

    let waited = 0;
    while (!endpoint && waited < 15000) {
      await page.waitForTimeout(500);
      waited += 500;
    }

    const cookieArr = await context.cookies();
    const cookieStr = cookieArr.map(c => `${c.name}=${c.value}`).join('; ');
    if (!capturedHeaders['cookie']) capturedHeaders['cookie'] = cookieStr;

  } finally {
    await browser.close();
  }

  if (!endpoint) {
    console.error('[ERROR] Could not capture endpoint');
    process.exit(1);
  }

  // Build request body with fresh UUIDs
  const body = JSON.parse(JSON.stringify(bodyTemplate)) as Record<string,unknown>;
  if ('requestId' in body)       body['requestId']       = uuidv4();
  if ('conversation_id' in body) body['conversation_id'] = uuidv4();
  if ('sessionId' in body)       body['sessionId']       = uuidv4();

  // Set message
  const msgFields = ['message','content','text','query','input','prompt','userMessage','msg'];
  for (const f of msgFields) {
    if (f in body) { body[f] = 'How do I improve my email open rates?'; break; }
  }

  const cleanHeaders: Record<string,string> = {};
  for (const [k, v] of Object.entries(capturedHeaders)) {
    if (['content-length','host','connection','transfer-encoding'].includes(k.toLowerCase())) continue;
    cleanHeaders[k] = v;
  }
  cleanHeaders['content-type'] = 'application/json';

  console.log('\n[SENDING] To:', endpoint);
  console.log('[SENDING] Body (truncated):', JSON.stringify(body).substring(0, 400));
  console.log('[SENDING] Auth header present:', 'authorization' in cleanHeaders);

  const start = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: cleanHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const elapsed = Date.now() - start;
    console.log(`\n[RESPONSE] Status: ${res.status} (${elapsed}ms)`);
    console.log('[RESPONSE] Headers:', JSON.stringify(Object.fromEntries(res.headers.entries())));
    const text = await res.text();
    console.log('[RESPONSE] Body:', text.substring(0, 1000));
  } catch (err: any) {
    console.error('[ERROR]', err.message);
  }
})();
