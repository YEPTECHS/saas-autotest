#!/usr/bin/env npx tsx
/**
 * Shopify 商店快速创建 - CDP 版本
 *
 * 连接到已登录的 Chrome，5-8秒完成整个流程
 *
 * 使用前：
 * 1. 关闭所有 Chrome 窗口
 * 2. 运行: pnpm shopify:cdp
 *    (会自动启动 Chrome 并启用 CDP)
 */

import { chromium, Browser, Page } from '@playwright/test';
import { spawn, execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// 配置
const CONFIG = {
  SHOPIFY_ORG_ID: '155064156',
  YEPAI_CLIENT_ID: '6f59e94645ee98a1ba5a77d17fc24d77',
  CDP_PORT: 9222,
  CDP_URL: 'http://127.0.0.1:9222',
  CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // 使用独立的 CDP profile，复制主 profile 的登录状态
  USER_DATA_DIR: join(homedir(), '.chrome-cdp-profile'),
  DEFAULT_CHROME_DIR: join(homedir(), 'Library/Application Support/Google/Chrome'),
  DATA_FILE: join(process.cwd(), 'data/shopify-oauth-urls.json'),
};

// 生成商店名
function generateStoreName(): string {
  return 'yepai-test-' + Math.floor(1000 + Math.random() * 9000);
}

// 检查 CDP 端口是否可用
async function isCDPAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.CDP_URL}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

// 复制 Chrome 登录状态到 CDP profile
function syncChromeProfile(): void {
  if (!existsSync(CONFIG.USER_DATA_DIR)) {
    mkdirSync(CONFIG.USER_DATA_DIR, { recursive: true });
  }

  const defaultDir = CONFIG.DEFAULT_CHROME_DIR;
  const cdpDir = CONFIG.USER_DATA_DIR;

  // 复制关键文件保持登录状态
  const filesToCopy = [
    'Default/Cookies',
    'Default/Login Data',
    'Default/Web Data',
    'Local State',
  ];

  // 创建 Default 目录
  const cdpDefaultDir = join(cdpDir, 'Default');
  if (!existsSync(cdpDefaultDir)) {
    mkdirSync(cdpDefaultDir, { recursive: true });
  }

  for (const file of filesToCopy) {
    const src = join(defaultDir, file);
    const dest = join(cdpDir, file);
    if (existsSync(src)) {
      try {
        // 确保目标目录存在
        const destDir = join(dest, '..');
        if (!existsSync(destDir)) {
          mkdirSync(destDir, { recursive: true });
        }
        execSync(`cp -f "${src}" "${dest}"`, { stdio: 'pipe' });
      } catch {}
    }
  }
}

// 启动 Chrome with CDP
async function launchChromeWithCDP(): Promise<void> {
  console.log('🚀 启动 Chrome (CDP 模式)...');

  // 检查 Chrome 是否正在运行
  let chromeRunning = false;
  try {
    execSync('pgrep "Google Chrome"', { stdio: 'pipe' });
    chromeRunning = true;
  } catch {}

  if (chromeRunning) {
    console.log('   ⚠️  Chrome 正在运行，需要关闭后重启...');
    console.log('   正在关闭 Chrome...');

    // 尝试优雅关闭
    try {
      execSync('osascript -e \'quit app "Google Chrome"\'', { stdio: 'pipe', timeout: 5000 });
    } catch {}
    await new Promise(r => setTimeout(r, 2000));

    // 确认是否还在运行
    try {
      execSync('pgrep "Google Chrome"', { stdio: 'pipe' });
      // 还在运行，强制关闭
      console.log('   强制关闭...');
      execSync('pkill -9 "Google Chrome"', { stdio: 'pipe' });
      await new Promise(r => setTimeout(r, 2000));
    } catch {
      // 已关闭
    }
  }

  // 确认 Chrome 已完全关闭
  try {
    execSync('pgrep "Google Chrome"', { stdio: 'pipe' });
    console.log('   ❌ Chrome 未能完全关闭');
    throw new Error('Chrome 未能关闭');
  } catch {
    console.log('   ✓ Chrome 已关闭');
  }

  // 同步 Chrome 登录状态到 CDP profile
  console.log('   同步登录状态...');
  syncChromeProfile();

  // 启动新 Chrome
  console.log('   启动 Chrome...');
  const chrome = spawn(CONFIG.CHROME_PATH, [
    `--remote-debugging-port=${CONFIG.CDP_PORT}`,
    `--user-data-dir=${CONFIG.USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  chrome.unref();

  // 等待 Chrome 启动
  await new Promise(r => setTimeout(r, 3000));

  // 等待 CDP 可用
  console.log('   等待 CDP 就绪...');
  for (let i = 0; i < 30; i++) {
    if (await isCDPAvailable()) {
      console.log('   ✓ Chrome 已启动\n');
      return;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // 超时后给出提示
  console.log('\n❌ Chrome CDP 启动失败');
  console.log('\n请手动执行以下步骤:');
  console.log('1. 关闭所有 Chrome 窗口');
  console.log('2. 在终端运行:');
  console.log(`   "${CONFIG.CHROME_PATH}" --remote-debugging-port=9222 --user-data-dir=${CONFIG.USER_DATA_DIR}`);
  console.log('3. 重新运行: pnpm shopify:cdp\n');
  throw new Error('Chrome CDP 启动超时');
}

// 保存 OAuth URL
interface OAuthRecord {
  storeName: string;
  storeUrl: string;
  oauthCallbackUrl: string;
  createdAt: string;
  used: boolean;
}

interface OAuthData {
  records: OAuthRecord[];
  lastUpdated: string;
}

function saveOAuthUrl(storeName: string, oauthUrl: string): void {
  const dataDir = join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  let data: OAuthData = { records: [], lastUpdated: '' };
  if (existsSync(CONFIG.DATA_FILE)) {
    data = JSON.parse(readFileSync(CONFIG.DATA_FILE, 'utf-8')) as OAuthData;
  }

  data.records.unshift({
    storeName,
    storeUrl: `${storeName}.myshopify.com`,
    oauthCallbackUrl: oauthUrl,
    createdAt: new Date().toISOString(),
    used: false,
  });
  data.lastUpdated = new Date().toISOString();

  writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
}

// 获取 WebSocket URL
async function getWsUrl(): Promise<string> {
  const res = await fetch(`${CONFIG.CDP_URL}/json/version`);
  const data = (await res.json()) as { webSocketDebuggerUrl: string };
  return data.webSocketDebuggerUrl;
}

// 主流程
async function createShopifyStore(): Promise<string> {
  const startTime = Date.now();
  const storeName = generateStoreName();

  console.log('═'.repeat(50));
  console.log(`  Shopify 商店创建 - CDP 快速版`);
  console.log(`  商店名称: ${storeName}`);
  console.log('═'.repeat(50) + '\n');

  // 检查/启动 Chrome
  if (!(await isCDPAvailable())) {
    await launchChromeWithCDP();
  } else {
    console.log('✓ Chrome CDP 已就绪\n');
  }

  // 获取 WebSocket URL
  const wsUrl = await getWsUrl();

  // 连接 Chrome
  console.log('📡 连接 Chrome...');
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();

  try {
    // ========== 步骤 1: 创建商店 ==========
    console.log('\n[1/4] 创建商店...');
    await page.goto(`https://admin.shopify.com/store-create/organization/${CONFIG.SHOPIFY_ORG_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    // 等待页面稳定
    await page.waitForTimeout(2000);

    // 检查登录状态
    const currentUrl = page.url();
    console.log(`   当前 URL: ${currentUrl}`);

    if (currentUrl.includes('accounts.shopify.com') || currentUrl.includes('/login')) {
      console.log('\n⚠️  未登录 Shopify');
      console.log('请先在普通 Chrome 中登录 Shopify Partners:');
      console.log('  1. 打开普通 Chrome (关闭当前 CDP Chrome)');
      console.log('  2. 访问 https://partners.shopify.com 并登录');
      console.log('  3. 重新运行: pnpm shopify:cdp');
      throw new Error('未登录 Shopify');
    }

    // 填写表单
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.fill('input[type="text"]', storeName);
    await page.selectOption('select', 'BASIC_APP_DEVELOPMENT');

    const checkbox = await page.$('input[type="checkbox"]');
    if (checkbox && !(await checkbox.isChecked())) {
      await checkbox.click();
    }

    // 点击创建
    await page.click('button:has-text("创建"), button:has-text("Create")');
    console.log('   ⏳ 等待商店创建...');

    // 等待跳转到商店页面
    await page.waitForURL(/\/store\//, { timeout: 60000 });
    console.log(`   ✓ 商店已创建 (${((Date.now() - startTime) / 1000).toFixed(1)}s)`);

    // ========== 步骤 2: OAuth 选择商店 ==========
    console.log('\n[2/4] 导航到 OAuth...');
    await page.goto(
      `https://admin.shopify.com/?organization_id=${CONFIG.SHOPIFY_ORG_ID}&no_redirect=true&redirect=/oauth/redirect_from_developer_dashboard?client_id%3D${CONFIG.YEPAI_CLIENT_ID}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // 等待页面加载
    await page.waitForTimeout(2000);

    // 搜索商店
    const searchInput = await page.$('input[type="search"], input[placeholder*="搜索"], input[placeholder*="Search"]');
    if (searchInput) {
      console.log('   搜索商店...');
      await searchInput.fill(storeName);
      await page.waitForTimeout(1500);
    }

    // 点击商店
    let clicked = false;
    for (let i = 0; i < 3; i++) {
      try {
        // 尝试点击包含商店名的链接
        const storeElement = await page.$(`text=${storeName}`);
        if (storeElement) {
          await storeElement.click();
          clicked = true;
          break;
        }
      } catch {}
      await page.waitForTimeout(1000);
    }

    if (!clicked) {
      await page.screenshot({ path: 'debug-oauth-page.png' });
      console.log('   ⚠️ 保存截图到 debug-oauth-page.png');
      throw new Error('找不到商店链接');
    }
    console.log('   ✓ 已选择商店');

    // ========== 步骤 3: 授权安装 ==========
    console.log('\n[3/4] 授权安装...');
    await page.waitForURL(/\/app\/grant/, { timeout: 10000 });
    await page.waitForSelector('button:has-text("安装"), button:has-text("Install")', { timeout: 5000 });
    await page.click('button:has-text("安装"), button:has-text("Install")');
    console.log('   ✓ 已点击安装');

    // ========== 步骤 4: 获取回调 URL ==========
    console.log('\n[4/4] 获取回调 URL...');
    await page.waitForURL(/yepai\.io/, { timeout: 30000 });
    const oauthUrl = page.url();

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

    // 保存结果
    saveOAuthUrl(storeName, oauthUrl);

    console.log('\n' + '═'.repeat(50));
    console.log('  ✅ 完成!');
    console.log(`  耗时: ${totalTime}s`);
    console.log(`  商店: ${storeName}.myshopify.com`);
    console.log('═'.repeat(50));
    console.log('\nOAuth URL:');
    console.log(oauthUrl);
    console.log('');

    return oauthUrl;

  } finally {
    await page.close();
  }
}

// 运行
createShopifyStore()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ 错误:', err.message);
    process.exit(1);
  });
