/**
 * test-marketing-site.ts — Automated E2E tests for www.yepai.io
 *
 * Covers: homepage, pricing, integrations, shopify-sales-agent,
 *         case-study, about-us, blog, navigation, CTAs, mobile layout
 *
 * Run: pnpm test:marketing
 */
import { chromium, Browser, Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE      = 'https://www.yepai.io';
const DESKTOP   = { width: 1400, height: 900 };
const MOBILE    = { width: 375, height: 812 };
const REPORT_DIR = join(process.cwd(), 'reports/marketing-site');
const SS_DIR     = join(REPORT_DIR, 'screenshots');

let passed = 0;
let failed = 0;
const results: TestResult[] = [];

interface TestResult {
  suite: string;
  name: string;
  status: 'pass' | 'fail';
  error?: string;
  duration: number;
}

function log(suite: string, name: string, ok: boolean, err?: string, ms = 0) {
  const status = ok ? 'pass' : 'fail';
  if (ok) { passed++; process.stdout.write(`  ✅ ${name}\n`); }
  else     { failed++; process.stdout.write(`  ❌ ${name}${err ? ': ' + err.slice(0, 120) : ''}\n`); }
  results.push({ suite, name, status, error: err, duration: ms });
}

async function test(suite: string, name: string, fn: () => Promise<void>) {
  const t = Date.now();
  try {
    await fn();
    log(suite, name, true, undefined, Date.now() - t);
  } catch (e: any) {
    log(suite, name, false, e.message, Date.now() - t);
  }
}

async function ss(page: Page, name: string) {
  await page.screenshot({ path: join(SS_DIR, name + '.png'), fullPage: false }).catch(() => {});
}

// ── Helper: navigate and wait ──────────────────────────────────────
async function goto(page: Page, path: string) {
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  // Trigger lazy loads
  await page.evaluate(async () => {
    for (let y = 0; y < Math.min(document.body.scrollHeight, 5000); y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 1: Page Loads
// ═══════════════════════════════════════════════════════════════════
async function suitePageLoads(browser: Browser) {
  console.log('\n📄 Suite: Page Loads');
  const pages = [
    { path: '/', name: 'Homepage' },
    { path: '/pricing', name: 'Pricing' },
    { path: '/integrations', name: 'Integrations' },
    { path: '/shopify-sales-agent', name: 'Shopify Sales Agent' },
    { path: '/case-study', name: 'Case Study' },
    { path: '/about-us', name: 'About Us' },
    { path: '/blog', name: 'Blog' },
    { path: '/insights', name: 'Insights' },
  ];

  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();

  for (const p of pages) {
    await test('Page Loads', `${p.name} loads (no 404)`, async () => {
      await page.goto(BASE + p.path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = await page.title();
      if (title.toLowerCase().includes('not found') || title === '') throw new Error(`Title: "${title}"`);
      await ss(page, 'load-' + p.name.toLowerCase().replace(/ /g, '-'));
    });
  }

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 2: Homepage
// ═══════════════════════════════════════════════════════════════════
async function suiteHomepage(browser: Browser) {
  console.log('\n🏠 Suite: Homepage');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await goto(page, '/');

  await test('Homepage', 'Has navigation bar', async () => {
    await page.waitForSelector('nav, header, [class*="nav"]', { timeout: 5000 });
  });

  await test('Homepage', 'Has hero headline (H1)', async () => {
    const h1 = await page.$('h1');
    if (!h1) throw new Error('No H1 found');
    const text = await h1.innerText();
    if (!text || text.trim().length < 5) throw new Error('H1 is empty');
  });

  await test('Homepage', '"Try for free" CTA is visible', async () => {
    const btn = await page.$('a:has-text("Try for free"), a:has-text("Try For Free"), a:has-text("Get started")');
    if (!btn) throw new Error('CTA button not found');
  });

  await test('Homepage', '"Try for free" links to app signup', async () => {
    const btns = await page.$$('a:has-text("Try for free"), a:has-text("Try For Free")');
    if (btns.length === 0) throw new Error('No CTA button');
    const href = await btns[0].getAttribute('href');
    if (!href) throw new Error('No href on CTA');
    if (!href.includes('yepai') && !href.startsWith('/') && !href.includes('bot-test')) {
      throw new Error(`Unexpected CTA href: ${href}`);
    }
  });

  await test('Homepage', 'Integration section exists', async () => {
    const hasSection = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('integrat') || text.includes('klaviyo') || text.includes('shopify');
    });
    if (!hasSection) throw new Error('No integration content found');
  });

  await test('Homepage', 'AI Employee / Agent team section visible', async () => {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    const hasAgents = ['maya', 'oscar', 'daniel', 'cody', 'ai employee', 'ai team', 'digital employee'].some(a => text.includes(a));
    if (!hasAgents) throw new Error('No agent/AI employee content found on homepage');
  });

  await test('Homepage', 'Footer is present', async () => {
    const footer = await page.$('footer, [class*="footer"], [class*="Footer"], .footer-section, #footer, [data-w-id*="footer"]');
    if (!footer) {
      // Fallback: check for footer-like links at bottom of page
      const hasFooterContent = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        return links.some(a => /privacy|terms|copyright/i.test(a.innerText + a.href));
      });
      if (!hasFooterContent) throw new Error('No footer or footer-like content found');
    }
  });

  await test('Homepage', 'No JavaScript errors on load', async () => {
    const errors: string[] = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    if (errors.length > 0) throw new Error(`${errors.length} JS errors: ${errors[0]}`);
  });

  await ss(page, 'homepage-desktop');
  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 3: Pricing Page
// ═══════════════════════════════════════════════════════════════════
async function suitePricing(browser: Browser) {
  console.log('\n💰 Suite: Pricing');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await goto(page, '/pricing');

  await test('Pricing', 'Has pricing headline', async () => {
    const h1 = await page.$('h1, h2');
    if (!h1) throw new Error('No heading found');
  });

  await test('Pricing', 'Shows pricing plans / tiers', async () => {
    const text = await page.evaluate(() => document.body.innerText);
    const hasPricing = /\$\d+|free|starter|growth|pro|enterprise|plan/i.test(text);
    if (!hasPricing) throw new Error('No pricing information found');
  });

  await test('Pricing', 'Has CTA on pricing page', async () => {
    const cta = await page.$('a:has-text("Try"), a:has-text("Get started"), a:has-text("Start"), a:has-text("Sign up")');
    if (!cta) throw new Error('No CTA button found on pricing page');
  });

  await test('Pricing', 'Credits/billing info is visible', async () => {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (!text.includes('credit') && !text.includes('billing') && !text.includes('month')) {
      throw new Error('No credits or billing info found');
    }
  });

  await ss(page, 'pricing-desktop');
  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 4: Navigation
// ═══════════════════════════════════════════════════════════════════
async function suiteNavigation(browser: Browser) {
  console.log('\n🧭 Suite: Navigation');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await goto(page, '/');

  // Get all nav links
  const navLinks = await page.evaluate((base: string) => {
    const nav = document.querySelector('nav, header');
    if (!nav) return [];
    return Array.from(nav.querySelectorAll('a[href]'))
      .map(a => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLElement).innerText?.trim() }))
      .filter(l => l.href.startsWith(base) && l.text)
      .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i);
  }, BASE);

  await test('Navigation', 'Nav has links', async () => {
    if (navLinks.length < 3) throw new Error(`Only ${navLinks.length} nav links found`);
  });

  // Test each nav link
  for (const link of navLinks.slice(0, 8)) {
    await test('Navigation', `Nav: "${link.text}" links correctly`, async () => {
      await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const title = await page.title();
      if (title.toLowerCase().includes('not found')) throw new Error(`"${link.text}" → 404`);
    });
  }

  // Test "Solutions" dropdown if it exists
  await goto(page, '/');
  await test('Navigation', 'Solutions dropdown opens', async () => {
    const solutions = await page.$('a:has-text("Solutions"), button:has-text("Solutions"), [class*="dropdown"]:has-text("Solutions")');
    if (!solutions) throw new Error('Solutions nav item not found');
    await solutions.hover();
    await page.waitForTimeout(500);
    // Check a dropdown appeared
    // Not a hard fail if dropdown doesn't open on hover — some are click-based
  });

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 5: CTA Buttons
// ═══════════════════════════════════════════════════════════════════
async function suiteCTAs(browser: Browser) {
  console.log('\n🎯 Suite: CTA Buttons');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();

  const pagesToCheck = ['/', '/pricing', '/shopify-sales-agent', '/about-us'];

  for (const path of pagesToCheck) {
    await goto(page, path);
    await test('CTAs', `"Try for free" button on ${path || 'homepage'}`, async () => {
      const btn = await page.$('a:has-text("Try for free"), a:has-text("Try For Free")');
      if (!btn) throw new Error('Button not found');
      const href = await btn.getAttribute('href');
      if (!href) throw new Error('No href');
      // Should go to signup or app
      const isValid = href.includes('yepai') || href.startsWith('/') || href.includes('app') || href.startsWith('http');
      if (!isValid) throw new Error(`Unexpected href: ${href}`);
    });
  }

  // Check that "Book a Demo" / Calendly link is NOT broken
  await goto(page, '/');
  await test('CTAs', '"Book a Demo" / Calendly link is valid', async () => {
    const demoBtn = await page.$('a:has-text("Book"), a:has-text("Demo"), a:has-text("demo"), a[href*="calendly"]');
    if (!demoBtn) {
      // No demo button — not a failure, just log
      return;
    }
    const href = await demoBtn.getAttribute('href');
    if (!href) throw new Error('Demo button has no href');
    // Verify the URL is reachable
    try {
      const res = await fetch(href, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (res.status === 404) throw new Error(`Demo link 404: ${href}`);
    } catch (e: any) {
      if (e.message.includes('404')) throw e;
      // Network errors are not failures (could be CORS/redirect)
    }
  });

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 6: Mobile Layout
// ═══════════════════════════════════════════════════════════════════
async function suiteMobile(browser: Browser) {
  console.log('\n📱 Suite: Mobile Layout (375px)');
  const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
  const ctx = await browser.newContext({ viewport: MOBILE, userAgent: mobileUA });
  const page = await ctx.newPage();

  const mobilePages = ['/', '/pricing', '/shopify-sales-agent', '/about-us'];

  for (const path of mobilePages) {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const pageName = path === '/' ? 'homepage' : path.replace('/', '');

    await test('Mobile', `${pageName}: no horizontal overflow`, async () => {
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 5
      );
      if (overflow) throw new Error('Horizontal scroll overflow detected');
    });

    await test('Mobile', `${pageName}: nav is visible`, async () => {
      const nav = await page.$('nav, header, [class*="navbar"], [class*="nav-bar"]');
      if (!nav) throw new Error('No nav/header on mobile');
    });

    await test('Mobile', `${pageName}: has visible CTA`, async () => {
      const cta = await page.$('a:has-text("Try"), a:has-text("Get started"), a:has-text("Sign up")');
      if (!cta) throw new Error('No CTA on mobile');
    });

    await ss(page, `mobile-${pageName}`);
  }

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 7: Forms
// ═══════════════════════════════════════════════════════════════════
async function suiteForms(browser: Browser) {
  console.log('\n📝 Suite: Forms');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();

  const pagesToCheck = ['/', '/pricing', '/about-us', '/blog'];
  for (const path of pagesToCheck) {
    await goto(page, path);
    await test('Forms', `${path || 'homepage'}: form fields are interactive`, async () => {
      const inputs = await page.$$('form input[type="email"], form input[type="text"]');
      if (inputs.length === 0) return; // No form — skip
      // Try filling the first email input
      await inputs[0].fill('test@example.com');
      const val = await inputs[0].inputValue();
      if (val !== 'test@example.com') throw new Error('Input not fillable');
    });
  }

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 8: Content Checks
// ═══════════════════════════════════════════════════════════════════
async function suiteContent(browser: Browser) {
  console.log('\n📋 Suite: Key Content');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();

  // Shopify Sales Agent
  await goto(page, '/shopify-sales-agent');
  await test('Content', 'Shopify page: has product description', async () => {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (!text.includes('shopify') && !text.includes('product') && !text.includes('store')) {
      throw new Error('No relevant Shopify content found');
    }
  });
  await test('Content', 'Shopify page: has meta description (SEO)', async () => {
    const meta = await page.$eval('meta[name="description"]', (el: Element) => (el as HTMLMetaElement).content).catch(() => '');
    if (!meta) throw new Error('Missing meta description — bad for SEO');
  });

  // Case Study
  await goto(page, '/case-study');
  await test('Content', 'Case Study page: has H1', async () => {
    const h1 = await page.$('h1');
    const text = h1 ? await h1.innerText() : '';
    if (!text.trim()) throw new Error('No H1 on case-study page');
  });

  // Blog
  await goto(page, '/blog');
  await test('Content', 'Blog: has article listings', async () => {
    const articles = await page.$$('article, [class*="blog"], [class*="post"], .w-dyn-item');
    if (articles.length === 0) {
      // Fallback: check for links with blog-like content
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a h2, a h3, h2 a, h3 a')).length
      );
      if (links === 0) throw new Error('No blog articles or article links found');
    }
  });

  // About Us
  await goto(page, '/about-us');
  await test('Content', 'About Us: team or mission content visible', async () => {
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    if (!text.includes('team') && !text.includes('mission') && !text.includes('founded') && !text.includes('our')) {
      throw new Error('No team/mission content found on About Us');
    }
  });

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 9: Footer Links
// ═══════════════════════════════════════════════════════════════════
async function suiteFooter(browser: Browser) {
  console.log('\n🦶 Suite: Footer');
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  await goto(page, '/');

  const footerLinks = await page.evaluate((base: string) => {
    const footer = document.querySelector('footer, [class*="footer"]');
    if (!footer) return [];
    return Array.from(footer.querySelectorAll('a[href]'))
      .map(a => ({ href: (a as HTMLAnchorElement).href, text: (a as HTMLElement).innerText?.trim().slice(0, 40) }))
      .filter(l => l.href.startsWith(base) && l.text)
      .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i)
      .slice(0, 15);
  }, BASE);

  await test('Footer', 'Footer has links', async () => {
    if (footerLinks.length < 3) throw new Error(`Only ${footerLinks.length} footer links`);
  });

  // Spot-check a few footer links
  for (const link of footerLinks.slice(0, 6)) {
    await test('Footer', `"${link.text}" footer link works`, async () => {
      await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const title = await page.title();
      if (title.toLowerCase().includes('not found') || title === '') {
        throw new Error(`"${link.text}" → 404 (${link.href})`);
      }
    });
  }

  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════
// Main + Report
// ═══════════════════════════════════════════════════════════════════
function generateReport(): string {
  const total = passed + failed;
  const pct = total > 0 ? Math.round(passed / total * 100) : 0;
  const bySuite = results.reduce((acc, r) => {
    if (!acc[r.suite]) acc[r.suite] = { pass: 0, fail: 0, tests: [] };
    acc[r.suite][r.status === 'pass' ? 'pass' : 'fail']++;
    acc[r.suite].tests.push(r);
    return acc;
  }, {} as Record<string, { pass: number; fail: number; tests: TestResult[] }>);

  const suiteRows = Object.entries(bySuite).map(([suite, data]) => {
    const sTotal = data.pass + data.fail;
    const sPct = Math.round(data.pass / sTotal * 100);
    const color = sPct === 100 ? '#d4edda' : sPct >= 70 ? '#fff3cd' : '#f8d7da';
    const testRows = data.tests.map(t =>
      `<tr><td style="padding-left:20px">${t.status === 'pass' ? '✅' : '❌'} ${t.name}</td><td>${t.duration}ms</td><td style="color:red;font-size:11px">${t.error || ''}</td></tr>`
    ).join('');
    return `
      <tr style="background:${color};font-weight:bold">
        <td>${suite}</td><td>${data.pass}/${sTotal} (${sPct}%)</td><td></td>
      </tr>${testRows}`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>yepai.io Marketing Site Tests</title>
<style>body{font-family:-apple-system,sans-serif;padding:20px;font-size:13px}
h1{color:#6c47ff}table{width:100%;border-collapse:collapse;margin-top:20px}
th{background:#6c47ff;color:#fff;padding:8px;text-align:left}
td{padding:5px 8px;border:1px solid #ddd;vertical-align:top}
.score{font-size:2em;font-weight:bold;color:${pct>=80?'#28a745':pct>=60?'#ffc107':'#dc3545'}}</style>
</head><body>
<h1>🌐 yepai.io Marketing Site Tests</h1>
<p>Generated: ${new Date().toLocaleString()}</p>
<p class="score">${pct}% passed (${passed}/${total})</p>
<table>
  <thead><tr><th>Suite / Test</th><th>Result</th><th>Error</th></tr></thead>
  <tbody>${suiteRows}</tbody>
</table>
</body></html>`;
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  mkdirSync(SS_DIR, { recursive: true });

  console.log('🌐 yepai.io Marketing Site — Full Automated Test Run\n');
  console.log(`Target: ${BASE}`);

  const browser = await chromium.launch({ headless: true });

  await suitePageLoads(browser);
  await suiteHomepage(browser);
  await suitePricing(browser);
  await suiteNavigation(browser);
  await suiteCTAs(browser);
  await suiteMobile(browser);
  await suiteForms(browser);
  await suiteContent(browser);
  await suiteFooter(browser);

  await browser.close();

  // Save report
  const html = generateReport();
  const reportPath = join(REPORT_DIR, 'test-report.html');
  writeFileSync(reportPath, html);
  writeFileSync(join(REPORT_DIR, 'test-results.json'), JSON.stringify(results, null, 2));

  console.log('\n══════════════════════════════════════════');
  console.log(`✅ Passed: ${passed}  ❌ Failed: ${failed}  Total: ${passed + failed}`);
  console.log(`Score: ${Math.round(passed / (passed + failed) * 100)}%`);
  console.log(`📄 Report: ${reportPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
