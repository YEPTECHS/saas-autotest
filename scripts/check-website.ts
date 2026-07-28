/**
 * check-website.ts — Comprehensive yepai.io website audit
 * Checks: broken links, JS errors, mobile layout, CTA targets, SEO, forms
 */
import { chromium, Browser, Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const BASE = 'https://www.yepai.io';
const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1400, height: 900 };
const OUT_DIR = join(process.cwd(), 'reports/website-audit');
const SS_DIR  = join(OUT_DIR, 'mobile-screenshots');

// Known pages to audit (from previous crawl)
const PAGES = [
  '/',
  '/pricing',
  '/integrations',
  '/shopify-sales-agent',
  '/case-study',
  '/about-us',
  '/blog',
  '/insights',
  '/glossary',
  '/privacy-policy',
  '/terms',
];

interface PageReport {
  url: string;
  title: string;
  h1: string;
  metaDesc: string;
  consoleErrors: string[];
  brokenLinks: { href: string; status: number; text: string }[];
  ctaButtons: { text: string; href: string; opensNewTab: boolean }[];
  forms: { action: string; fields: string[]; hasSubmit: boolean }[];
  mobileScreenshot: string;
  mobileIssues: string[];
  loadedOk: boolean;
}

async function checkLinkStatus(url: string): Promise<number> {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return r.status;
  } catch {
    try {
      const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
      return r.status;
    } catch {
      return 0;
    }
  }
}

async function auditPage(browser: Browser, path: string): Promise<PageReport> {
  const url = BASE + path;
  console.log(`\n── Auditing ${path}`);

  const consoleErrors: string[] = [];
  const ssFile = join(SS_DIR, path.replace(/\//g, '_').replace(/^_/, '') || 'home') + '.png';

  // ── Desktop pass: links, CTAs, SEO, forms, console errors ──
  const desktopCtx = await browser.newContext({ viewport: DESKTOP });
  const page = await desktopCtx.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200));
  });
  page.on('pageerror', err => consoleErrors.push('PageError: ' + err.message.slice(0, 200)));

  let loadedOk = true;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    // Trigger lazy loads
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);
  } catch (e: any) {
    loadedOk = false;
    console.log(`  ERROR loading: ${e.message?.slice(0, 80)}`);
  }

  // SEO
  const seo = await page.evaluate(() => ({
    title: document.title,
    h1: (document.querySelector('h1') as HTMLElement)?.innerText?.trim() || '',
    metaDesc: (document.querySelector('meta[name="description"]') as HTMLMetaElement)?.content || '',
  }));

  // All internal links
  const allLinks = await page.evaluate((base: string) => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({
        href: (a as HTMLAnchorElement).href,
        text: ((a as HTMLElement).innerText || '').trim().slice(0, 60),
        isInternal: (a as HTMLAnchorElement).href.startsWith(base),
      }))
      .filter(l => l.href && !l.href.startsWith('mailto:') && !l.href.startsWith('tel:') && !l.href.startsWith('javascript:'));
  }, BASE);

  // CTA buttons — prominent action buttons
  const ctaButtons = await page.evaluate((base: string) => {
    const selectors = [
      'a[class*="btn"]', 'a[class*="button"]', 'a[class*="cta"]',
      '.w-button', 'a.button', 'a[class*="Button"]',
    ];
    const seen = new Set<string>();
    const results: { text: string; href: string; opensNewTab: boolean }[] = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const a = el as HTMLAnchorElement;
        const key = a.href + a.innerText;
        if (!seen.has(key) && a.innerText?.trim()) {
          seen.add(key);
          results.push({
            text: a.innerText.trim().slice(0, 60),
            href: a.href,
            opensNewTab: a.target === '_blank',
          });
        }
      });
    }
    return results.slice(0, 20);
  }, BASE);

  // Forms
  const forms = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form')).map(form => ({
      action: form.action || '',
      fields: Array.from(form.querySelectorAll('input,textarea,select'))
        .map(el => `${el.tagName.toLowerCase()}[${(el as HTMLInputElement).type || (el as HTMLInputElement).name || '?'}]`)
        .slice(0, 10),
      hasSubmit: !!form.querySelector('button[type="submit"],input[type="submit"]'),
    }));
  });

  await desktopCtx.close();

  // ── Check link statuses (sample: internal + important external) ──
  const linksToCheck = [
    ...allLinks.filter(l => l.isInternal).slice(0, 30),
    ...allLinks.filter(l => !l.isInternal && ctaButtons.some(c => c.href === l.href)).slice(0, 5),
  ];
  const uniqueLinks = [...new Map(linksToCheck.map(l => [l.href, l])).values()];

  console.log(`  Checking ${uniqueLinks.length} links...`);
  const brokenLinks: PageReport['brokenLinks'] = [];
  for (const link of uniqueLinks) {
    const status = await checkLinkStatus(link.href);
    if (status === 404 || status === 0 || status >= 500) {
      brokenLinks.push({ href: link.href, status, text: link.text });
      console.log(`  ❌ ${status} ${link.href.slice(0, 80)}`);
    }
  }

  // ── Mobile pass: screenshot + layout issues ──
  const mobileCtx = await browser.newContext({ viewport: MOBILE, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' });
  const mobilePage = await mobileCtx.newPage();
  const mobileIssues: string[] = [];

  try {
    await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mobilePage.waitForTimeout(2000);
    await mobilePage.screenshot({ path: ssFile, fullPage: false });

    // Check for horizontal overflow
    const hasHScroll = await mobilePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (hasHScroll) mobileIssues.push('Horizontal scroll overflow detected');

    // Check for very small text
    const tinyText = await mobilePage.evaluate(() => {
      const els = Array.from(document.querySelectorAll('p,span,li,a'));
      return els.filter(el => {
        const size = parseInt(window.getComputedStyle(el).fontSize);
        return size > 0 && size < 11;
      }).length;
    });
    if (tinyText > 3) mobileIssues.push(`${tinyText} elements with font-size < 11px`);

    // Check nav is present
    const hasNav = await mobilePage.evaluate(() => !!document.querySelector('nav,header,[class*="nav"],[class*="header"]'));
    if (!hasNav) mobileIssues.push('No nav/header detected');

  } catch (e: any) {
    mobileIssues.push('Failed to load on mobile: ' + e.message?.slice(0, 80));
  }
  await mobileCtx.close();

  const report: PageReport = {
    url,
    title: seo.title,
    h1: seo.h1,
    metaDesc: seo.metaDesc,
    consoleErrors,
    brokenLinks,
    ctaButtons,
    forms,
    mobileScreenshot: ssFile,
    mobileIssues,
    loadedOk,
  };

  // Summary log
  console.log(`  SEO — title: "${seo.title.slice(0, 60)}" | h1: "${seo.h1.slice(0, 40)}" | desc: ${seo.metaDesc ? '✅' : '❌ missing'}`);
  console.log(`  Console errors: ${consoleErrors.length} | Broken links: ${brokenLinks.length} | CTAs: ${ctaButtons.length} | Forms: ${forms.length}`);
  console.log(`  Mobile issues: ${mobileIssues.length === 0 ? '✅ none' : mobileIssues.join(', ')}`);

  return report;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SS_DIR, { recursive: true });

  console.log('🔍 Starting yepai.io comprehensive audit...\n');
  const browser = await chromium.launch({ headless: true });
  const reports: PageReport[] = [];

  for (const path of PAGES) {
    try {
      const r = await auditPage(browser, path);
      reports.push(r);
    } catch (e: any) {
      console.log(`  FATAL error on ${path}: ${e.message}`);
    }
  }

  await browser.close();

  // Save JSON
  writeFileSync(join(OUT_DIR, 'audit.json'), JSON.stringify(reports, null, 2));

  // Generate HTML report
  const html = generateHTML(reports);
  const htmlPath = join(OUT_DIR, 'audit-report.html');
  writeFileSync(htmlPath, html);

  console.log('\n\n══════════════════════════════════════');
  console.log('✅ Audit complete');
  console.log(`📄 Report: ${htmlPath}`);
  printSummary(reports);
}

function printSummary(reports: PageReport[]) {
  console.log('\n📊 SUMMARY\n');
  let totalBroken = 0, totalErrors = 0, totalMobile = 0, seoIssues = 0;
  for (const r of reports) {
    totalBroken += r.brokenLinks.length;
    totalErrors += r.consoleErrors.length;
    totalMobile += r.mobileIssues.length;
    if (!r.metaDesc || !r.h1 || !r.title) seoIssues++;
    const issues = [];
    if (r.brokenLinks.length) issues.push(`${r.brokenLinks.length} broken links`);
    if (r.consoleErrors.length) issues.push(`${r.consoleErrors.length} JS errors`);
    if (r.mobileIssues.length) issues.push(`mobile: ${r.mobileIssues[0]}`);
    if (!r.metaDesc) issues.push('no meta desc');
    if (!r.h1) issues.push('no H1');
    const status = issues.length === 0 ? '✅' : '⚠️ ';
    console.log(`  ${status} ${r.url.replace(BASE, '')}: ${issues.join(' | ') || 'all good'}`);
  }
  console.log(`\nTotal broken links: ${totalBroken}`);
  console.log(`Total JS errors: ${totalErrors}`);
  console.log(`Total mobile issues: ${totalMobile}`);
  console.log(`Pages with SEO gaps: ${seoIssues}`);
}

function generateHTML(reports: PageReport[]): string {
  const rows = reports.map(r => {
    const issues: string[] = [];
    r.brokenLinks.forEach(l => issues.push(`🔗 404: ${l.href.replace(BASE, '')}`));
    r.consoleErrors.forEach(e => issues.push(`🐛 JS: ${e.slice(0, 100)}`));
    r.mobileIssues.forEach(m => issues.push(`📱 ${m}`));
    if (!r.title) issues.push('⚠️ Missing &lt;title&gt;');
    if (!r.h1) issues.push('⚠️ Missing H1');
    if (!r.metaDesc) issues.push('⚠️ Missing meta description');

    const seoColor = (!r.title || !r.h1 || !r.metaDesc) ? '#fff3cd' : '#d4edda';
    return `
    <tr>
      <td><a href="${r.url}" target="_blank">${r.url.replace(BASE, '') || '/'}</a></td>
      <td style="background:${seoColor}">
        <b>Title:</b> ${r.title || '<em>missing</em>'}<br>
        <b>H1:</b> ${r.h1 || '<em>missing</em>'}<br>
        <b>Desc:</b> ${r.metaDesc ? '✅ ' + r.metaDesc.slice(0, 80) + '…' : '<em>❌ missing</em>'}
      </td>
      <td>${r.ctaButtons.map(c => `<span title="${c.href}">${c.text}</span>${c.opensNewTab ? ' ↗' : ''}`).join('<br>') || '-'}</td>
      <td>${r.forms.map(f => f.fields.join(', ')).join('<br>') || '-'}</td>
      <td style="background:${issues.length ? '#f8d7da' : '#d4edda'}">${issues.map(i => `<div>${i}</div>`).join('') || '✅'}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>yepai.io Website Audit</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 20px; font-size: 13px; }
  h1 { color: #6c47ff; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th { background: #6c47ff; color: white; padding: 8px; text-align: left; }
  td { padding: 6px 8px; border: 1px solid #ddd; vertical-align: top; }
  tr:nth-child(even) td { background: #f9f9f9; }
</style>
</head>
<body>
<h1>🔍 yepai.io Website Audit</h1>
<p>Generated: ${new Date().toLocaleString()}</p>
<table>
  <thead><tr>
    <th>Page</th>
    <th>SEO (title / H1 / meta desc)</th>
    <th>CTA Buttons</th>
    <th>Forms</th>
    <th>Issues</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body>
</html>`;
}

main().catch(e => { console.error(e); process.exit(1); });
