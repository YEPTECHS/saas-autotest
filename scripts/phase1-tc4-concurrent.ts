/**
 * Phase 1 TC4: 并发同步测试
 *
 * 用两个不同账号同时触发"立即同步"，验证：
 *   1. 两个账号都看到扫描动画（互不干扰）
 *   2. 两个账号最终都成功完成同步
 *   3. 数据严格隔离（账号 A 看不到账号 B 的商品）
 *   4. Console 无红色 ERROR
 *
 * 使用方法:
 *   pnpm phase1:tc4
 *
 * 前置条件:
 *   - data/test-users.json 中至少有 2 个账号，各自已绑定不同的 Shopify 店铺
 *   - .env 中配置了 YEPAI_BASE_URL
 */

import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';
import 'dotenv/config';

const BASE_URL = process.env.YEPAI_BASE_URL || 'https://bot-test.yepai.io';
const HEADLESS = process.env.HEADLESS === 'true';
const TIMEOUT = parseInt(process.env.TIMEOUT || '60000', 10);

interface TestUser {
  email: string;
  password: string;
}

interface SessionResult {
  userEmail: string;
  loginSuccess: boolean;
  animationSeen: boolean;
  syncCompleted: boolean;
  lambdaMessage: string | null;
  isNewPath: boolean;
  productCount: number;
  consoleErrors: string[];
  error?: string;
}

// ── Load test users ────────────────────────────────────────────

const usersData = JSON.parse(readFileSync(join(process.cwd(), 'data/test-users.json'), 'utf-8'));
const users: TestUser[] = usersData.users.slice(0, 2);

if (users.length < 2) {
  console.error('[TC4] ❌ data/test-users.json 中需要至少 2 个账号');
  process.exit(1);
}

// ── Per-session test logic ─────────────────────────────────────

async function runSession(
  browser: Browser,
  user: TestUser,
  sessionId: string,
): Promise<SessionResult> {
  const result: SessionResult = {
    userEmail: user.email,
    loginSuccess: false,
    animationSeen: false,
    syncCompleted: false,
    lambdaMessage: null,
    isNewPath: false,
    productCount: 0,
    consoleErrors: [],
  };

  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page: Page = await context.newPage();

  // 收集 console 错误
  page.on('console', msg => {
    if (msg.type() === 'error') {
      result.consoleErrors.push(msg.text());
    }
  });

  try {
    // ── Step 1: 登录 ─────────────────────────────────────────

    console.log(`[${sessionId}] 登录 ${user.email}...`);
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
    await page.locator("input[type='email'], input[name='email'], #email").fill(user.email);
    await page.locator("input[type='password'], input[name='password'], #password").fill(user.password);
    await page.locator("button[type='submit']").click();
    await page.waitForSelector("nav, [class*='sidebar']", { timeout: 30000 });
    result.loginSuccess = true;
    console.log(`[${sessionId}] ✅ 登录成功`);

    // ── Step 2: 设置 fetch 拦截器 ──────────────────────────

    await page.evaluate(() => {
      (window as any).__lambdaTaskResult = null;
      const origFetch = window.fetch.bind(window);
      (window as any).fetch = async function (url: string, ...args: unknown[]) {
        const res = await origFetch(url, ...args);
        const urlStr = typeof url === 'string' ? url : (url as any)?.url || '';
        if (urlStr.includes('lambdatask')) {
          try { res.clone().json().then((d: unknown) => { (window as any).__lambdaTaskResult = d; }); } catch (_) {}
        }
        return res;
      };
    });

    // ── Step 3: 导航到 Shopify 集成页 ─────────────────────

    await page.goto(`${BASE_URL}/integrations/shopify`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main', { timeout: 15000 });
    console.log(`[${sessionId}] Shopify 集成页面已加载`);

  } catch (err) {
    result.error = `Setup failed: ${err}`;
    console.error(`[${sessionId}] ❌ Setup 失败:`, err);
    await context.close();
    return result;
  }

  // 返回 page 和 context 供并发协调使用
  (result as any).__page = page;
  (result as any).__context = context;
  return result;
}

async function triggerSyncAndVerify(
  result: SessionResult,
  sessionId: string,
): Promise<void> {
  const page: Page = (result as any).__page;

  try {
    // ── Step 4: 点击同步 ────────────────────────────────────

    const syncBtn = page.locator(
      "button:has-text('Sync Now'), button:has-text('立即同步'), button:has-text('Resync'), button:has-text('Sync')"
    ).first();
    await syncBtn.click({ timeout: TIMEOUT });
    console.log(`[${sessionId}] ✅ 已点击同步按钮`);

    // ── Step 5: 检查动画 ────────────────────────────────────

    try {
      await page.waitForSelector(
        "[class*='progress'], [class*='scan'], [class*='loading'], [class*='sync'], [role='progressbar']",
        { timeout: 15000 }
      );
      result.animationSeen = true;
      console.log(`[${sessionId}] ✅ 扫描动画出现`);
    } catch {
      console.warn(`[${sessionId}] ⚠️ 未检测到扫描动画（可能已快速完成）`);
    }

    // ── Step 6: 等待 lambdatask 响应 ────────────────────────

    const lambdaResult = await page.evaluate((): Promise<{ message?: string } | null> => {
      return new Promise(resolve => {
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          if ((window as any).__lambdaTaskResult !== null || attempts >= 20) {
            clearInterval(check);
            resolve((window as any).__lambdaTaskResult);
          }
        }, 500);
      });
    });

    result.lambdaMessage = lambdaResult?.message || null;
    result.isNewPath = (result.lambdaMessage || '').startsWith('InJavaWorkflow:');
    console.log(`[${sessionId}] lambdatask message: ${result.lambdaMessage}`);

    // ── Step 7: 等待同步完成 ─────────────────────────────────

    try {
      await page.waitForSelector(
        "[class*='success'], [class*='complete'], [class*='done']",
        { timeout: 300000 }
      );
      result.syncCompleted = true;
    } catch {
      // 有时完成后直接跳转，不展示独立的 success 元素
      const bodyText = await page.evaluate(() => document.body.innerText);
      result.syncCompleted = ['完成', 'Success', 'Complete', 'Done', '成功'].some(w => bodyText.includes(w));
    }
    console.log(`[${sessionId}] 同步完成状态: ${result.syncCompleted}`);

    // ── Step 8: 读取 Knowledge Sources 商品数 ────────────────

    await page.goto(`${BASE_URL}/ai-training/knowledge`, { waitUntil: 'networkidle' });
    await page.waitForSelector('main', { timeout: 15000 });
    await page.waitForTimeout(3000);

    result.productCount = await page.evaluate(() => {
      return document.querySelectorAll('[class*="item"], [class*="card"], [class*="product"], tr').length;
    });
    console.log(`[${sessionId}] Knowledge Sources 商品数: ${result.productCount}`);

  } catch (err) {
    result.error = `Sync/verify failed: ${err}`;
    console.error(`[${sessionId}] ❌ 同步/验证失败:`, err);
  } finally {
    const context: BrowserContext = (result as any).__context;
    await context.close();
  }
}

// ── Data isolation check ───────────────────────────────────────

async function checkDataIsolation(
  browser: Browser,
  userA: TestUser,
  userB: TestUser,
): Promise<boolean> {
  console.log('\n[TC4] === 检查多租户数据隔离 ===');
  // 用账号 A 登录，拿到它的商品列表文本
  const ctxA = await browser.newContext();
  const pageA = await ctxA.newPage();
  await pageA.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await pageA.locator("input[type='email'], input[name='email'], #email").fill(userA.email);
  await pageA.locator("input[type='password'], input[name='password'], #password").fill(userA.password);
  await pageA.locator("button[type='submit']").click();
  await pageA.waitForSelector("nav, [class*='sidebar']", { timeout: 30000 });
  await pageA.goto(`${BASE_URL}/ai-training/knowledge`, { waitUntil: 'networkidle' });
  await pageA.waitForTimeout(3000);
  const textA = await pageA.evaluate(() => document.body.innerText);
  await ctxA.close();

  // 用账号 B 登录，拿到它的商品列表文本
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await pageB.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await pageB.locator("input[type='email'], input[name='email'], #email").fill(userB.email);
  await pageB.locator("input[type='password'], input[name='password'], #password").fill(userB.password);
  await pageB.locator("button[type='submit']").click();
  await pageB.waitForSelector("nav, [class*='sidebar']", { timeout: 30000 });
  await pageB.goto(`${BASE_URL}/ai-training/knowledge`, { waitUntil: 'networkidle' });
  await pageB.waitForTimeout(3000);
  const textB = await pageB.evaluate(() => document.body.innerText);
  await ctxB.close();

  // 简单检查：两份页面文本不应完全相同（如果店铺不同商品不同）
  const identical = textA.trim() === textB.trim();
  if (identical) {
    console.warn('[TC4] ⚠️ 两个账号的 Knowledge Sources 内容完全相同，可能存在数据混串或两家店铺商品相同（需人工确认）');
  } else {
    console.log('[TC4] ✅ 两个账号的 Knowledge Sources 内容不同（数据隔离正常）');
  }
  return !identical;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  Phase 1 TC4: 并发同步测试');
  console.log(`  Base URL: ${BASE_URL}`);
  console.log(`  账号 A: ${users[0].email}`);
  console.log(`  账号 B: ${users[1].email}`);
  console.log('========================================\n');

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: 50 });

  try {
    // ── 阶段 1: 两个 session 各自登录并导航到 Shopify 页面 ──

    console.log('[TC4] === 阶段 1: 两账号各自准备 ===');
    const [resultA, resultB] = await Promise.all([
      runSession(browser, users[0], 'Session-A'),
      runSession(browser, users[1], 'Session-B'),
    ]);

    if (!resultA.loginSuccess || !resultB.loginSuccess) {
      console.error('[TC4] ❌ 登录失败，终止测试');
      console.error('  Session-A 登录:', resultA.loginSuccess, resultA.error || '');
      console.error('  Session-B 登录:', resultB.loginSuccess, resultB.error || '');
      return;
    }

    // ── 阶段 2: 同时点击同步按钮 ────────────────────────────

    console.log('\n[TC4] === 阶段 2: 同时触发两账号同步 ===');
    await Promise.all([
      triggerSyncAndVerify(resultA, 'Session-A'),
      triggerSyncAndVerify(resultB, 'Session-B'),
    ]);

    // ── 阶段 3: 数据隔离验证 ─────────────────────────────────

    const isolationOk = await checkDataIsolation(browser, users[0], users[1]);

    // ── 最终报告 ─────────────────────────────────────────────

    console.log('\n========== TC4 测试报告 ==========');

    const checks = [
      { label: '账号 A 登录成功', pass: resultA.loginSuccess },
      { label: '账号 B 登录成功', pass: resultB.loginSuccess },
      { label: '账号 A 扫描动画出现', pass: resultA.animationSeen },
      { label: '账号 B 扫描动画出现', pass: resultB.animationSeen },
      { label: '账号 A 同步完成', pass: resultA.syncCompleted },
      { label: '账号 B 同步完成', pass: resultB.syncCompleted },
      { label: '账号 A lambdatask 走新路径', pass: resultA.isNewPath },
      { label: '账号 B lambdatask 走新路径', pass: resultB.isNewPath },
      { label: '数据隔离正常', pass: isolationOk },
      { label: '账号 A 无 Console 错误', pass: resultA.consoleErrors.length === 0 },
      { label: '账号 B 无 Console 错误', pass: resultB.consoleErrors.length === 0 },
    ];

    for (const { label, pass } of checks) {
      console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    }

    console.log('\n  详细数据:');
    console.log(`  账号 A lambdatask message: ${resultA.lambdaMessage || '(无响应)'}`);
    console.log(`  账号 B lambdatask message: ${resultB.lambdaMessage || '(无响应)'}`);
    console.log(`  账号 A Knowledge Sources 项目数: ${resultA.productCount}`);
    console.log(`  账号 B Knowledge Sources 项目数: ${resultB.productCount}`);

    if (resultA.consoleErrors.length > 0) {
      console.log(`\n  账号 A Console 错误:\n    ${resultA.consoleErrors.join('\n    ')}`);
    }
    if (resultB.consoleErrors.length > 0) {
      console.log(`\n  账号 B Console 错误:\n    ${resultB.consoleErrors.join('\n    ')}`);
    }

    const allPassed = checks.every(c => c.pass);
    console.log(`\n  总体结果: ${allPassed ? '✅ PASS' : '❌ FAIL（请查看失败项）'}`);
    console.log('===================================\n');

    process.exit(allPassed ? 0 : 1);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('[TC4] 未捕获异常:', err);
  process.exit(1);
});
