/**
 * Shopify 开发商店快速创建脚本
 *
 * 特点：
 * 1. 使用 CDP 连接到已运行的 Chrome（无需关闭 Chrome）
 * 2. 使用固定选择器（不依赖 AI 识别，速度快）
 * 3. 直接输出 OAuth 回调 URL
 *
 * 使用方法：
 * 1. 先启动 Chrome 并启用远程调试：
 *    /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *
 * 2. 运行脚本：
 *    pnpm shopify:create
 *
 * 或者使用 --new-window 模式（会创建新的 Chrome 配置目录）：
 *    pnpm shopify:create --new-window
 */

import { chromium, Page, BrowserContext } from '@playwright/test';
import { config } from 'dotenv';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, cpSync } from 'fs';

config();

// Shopify 配置
const SHOPIFY_ORG_ID = process.env.SHOPIFY_ORG_ID || '155064156';
const YEPAI_CLIENT_ID = process.env.YEPAI_CLIENT_ID || '6f59e94645ee98a1ba5a77d17fc24d77';

// Chrome 远程调试端口
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

// Chrome 用户数据目录
const CHROME_USER_DATA_DIR = join(homedir(), 'Library/Application Support/Google/Chrome');
const PLAYWRIGHT_CHROME_DIR = join(homedir(), '.yepai-chrome-profile');

// 我们在手动测试中发现的选择器
const SELECTORS = {
  // 创建商店页面
  storeNameInput: 'input[type="text"]:not([type="hidden"])',
  planSelect: 'select',
  testDataCheckbox: 'input[type="checkbox"]',
  createButton: 'button:has-text("创建商店"), button:has-text("Create")',

  // 商店选择页面
  storeListItem: (storeName: string) => `a[href*="${storeName}"], [data-store-name="${storeName}"]`,

  // OAuth 授权页面
  installButton: 'button:has-text("安装"), button:has-text("Install")',
};

// 生成唯一商店名称
function generateStoreName(): string {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `yepai-test-${suffix}`;
}

// 等待并点击元素
async function waitAndClick(page: Page, selector: string, timeout = 10000): Promise<void> {
  await page.waitForSelector(selector, { timeout, state: 'visible' });
  await page.click(selector);
}

// 复制 Chrome cookies 到 Playwright 配置目录
async function setupChromeProfile(): Promise<void> {
  if (!existsSync(PLAYWRIGHT_CHROME_DIR)) {
    console.log('📂 首次运行，复制 Chrome 配置...');
    mkdirSync(PLAYWRIGHT_CHROME_DIR, { recursive: true });

    // 复制关键文件（cookies、登录状态）
    const filesToCopy = ['Default/Cookies', 'Default/Login Data', 'Default/Web Data', 'Local State'];
    for (const file of filesToCopy) {
      const src = join(CHROME_USER_DATA_DIR, file);
      const dest = join(PLAYWRIGHT_CHROME_DIR, file);
      if (existsSync(src)) {
        const destDir = join(PLAYWRIGHT_CHROME_DIR, file.split('/').slice(0, -1).join('/'));
        if (destDir !== PLAYWRIGHT_CHROME_DIR) {
          mkdirSync(destDir, { recursive: true });
        }
        try {
          cpSync(src, dest);
          console.log(`   ✓ 复制: ${file}`);
        } catch (e) {
          console.log(`   ⚠ 跳过: ${file} (可能被锁定)`);
        }
      }
    }
  }
}

// 连接到 Chrome 的不同方式
async function connectToChrome(): Promise<{ context: BrowserContext; page: Page; cleanup: () => Promise<void> }> {
  const useNewWindow = process.argv.includes('--new-window');

  // 方式 1: 尝试通过 CDP 连接到已运行的 Chrome
  if (!useNewWindow) {
    try {
      console.log('🔌 尝试连接到 Chrome (CDP)...');
      const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
      const contexts = browser.contexts();
      const context = contexts[0];
      const page = await context.newPage();

      console.log('   ✓ 已连接到运行中的 Chrome\n');

      return {
        context,
        page,
        cleanup: async () => {
          await page.close();
          // 不关闭浏览器，只关闭我们创建的页面
        }
      };
    } catch (e) {
      console.log('   ⚠ CDP 连接失败，尝试其他方式...\n');
    }
  }

  // 方式 2: 使用独立的配置目录启动新 Chrome
  console.log('🚀 启动新的 Chrome 窗口...');
  await setupChromeProfile();

  const context = await chromium.launchPersistentContext(PLAYWRIGHT_CHROME_DIR, {
    headless: false,
    slowMo: 50,
    viewport: { width: 1280, height: 800 },
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();

  return {
    context,
    page,
    cleanup: async () => {
      await context.close();
    }
  };
}

// 主流程
async function createShopifyStoreAndGetOAuthUrl(): Promise<string> {
  console.log('🚀 启动 Shopify 商店创建流程（快速模式）\n');

  const { context, page, cleanup } = await connectToChrome();
  const storeName = generateStoreName();

  try {
    // ========================================
    // 步骤 1: 导航到商店创建页面
    // ========================================
    console.log(`\n📋 步骤 1: 创建商店 "${storeName}"`);
    const createUrl = `https://admin.shopify.com/store-create/organization/${SHOPIFY_ORG_ID}`;
    await page.goto(createUrl, { waitUntil: 'networkidle', timeout: 60000 });

    // 等待页面加载
    await page.waitForTimeout(2000);

    // 检查是否需要登录（如果重定向到登录页）
    if (page.url().includes('accounts.shopify.com') || page.url().includes('login')) {
      console.log('❌ 需要登录！请先在 Chrome 中登录 Shopify Partner Dashboard');
      throw new Error('Not logged in to Shopify');
    }

    // ========================================
    // 步骤 2: 填写商店表单
    // ========================================
    console.log('📝 步骤 2: 填写表单');

    // 填写商店名称
    const nameInput = await page.waitForSelector(SELECTORS.storeNameInput, { timeout: 30000 });
    await nameInput.fill(storeName);
    console.log(`   ✓ 商店名称: ${storeName}`);

    // 选择套餐 (Basic)
    await page.selectOption(SELECTORS.planSelect, 'BASIC_APP_DEVELOPMENT');
    console.log('   ✓ 套餐: Basic');

    // 勾选生成测试数据
    const checkbox = await page.$(SELECTORS.testDataCheckbox);
    if (checkbox) {
      const isChecked = await checkbox.isChecked();
      if (!isChecked) {
        await checkbox.click();
      }
      console.log('   ✓ 生成测试数据: 已勾选');
    }

    // ========================================
    // 步骤 3: 点击创建商店
    // ========================================
    console.log('🔨 步骤 3: 创建商店');

    // 找到并点击创建按钮
    const createBtn = await page.$('button[type="button"]:has-text("创建")')
      || await page.$('button:has-text("Create")');
    if (createBtn) {
      await createBtn.click();
    } else {
      // 尝试通过 JavaScript 点击
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.includes('创建') || btn.textContent?.includes('Create')) {
            btn.click();
            break;
          }
        }
      });
    }

    // 等待商店创建完成（URL 变化）
    console.log('   ⏳ 等待商店创建...');
    await page.waitForURL(/admin\.shopify\.com\/store\//, { timeout: 120000 });
    console.log(`   ✓ 商店创建成功: ${page.url()}`);

    // ========================================
    // 步骤 4: 导航到 OAuth URL
    // ========================================
    console.log('\n🔗 步骤 4: 启动 OAuth 流程');

    const oauthUrl = `https://admin.shopify.com/?organization_id=${SHOPIFY_ORG_ID}&no_redirect=true&redirect=/oauth/redirect_from_developer_dashboard?client_id%3D${YEPAI_CLIENT_ID}`;
    await page.goto(oauthUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);

    // ========================================
    // 步骤 5: 选择刚创建的商店
    // ========================================
    console.log('🏪 步骤 5: 选择商店');

    // 点击我们刚创建的商店
    const storeLink = await page.$(`a:has-text("${storeName}")`);
    if (storeLink) {
      await storeLink.click();
      console.log(`   ✓ 已选择商店: ${storeName}`);
    } else {
      // 尝试通过文本查找
      await page.evaluate((name) => {
        const links = document.querySelectorAll('a');
        for (const link of links) {
          if (link.textContent?.includes(name)) {
            link.click();
            break;
          }
        }
      }, storeName);
    }

    // 等待跳转到授权页面
    await page.waitForTimeout(3000);

    // ========================================
    // 步骤 6: 点击安装按钮
    // ========================================
    console.log('📦 步骤 6: 授权安装');

    // 等待安装页面加载
    if (page.url().includes('/app/grant')) {
      const installBtn = await page.$('button:has-text("安装")')
        || await page.$('button:has-text("Install")');
      if (installBtn) {
        await installBtn.click();
        console.log('   ✓ 已点击安装按钮');
      } else {
        await page.evaluate(() => {
          const buttons = document.querySelectorAll('button');
          for (const btn of buttons) {
            if (btn.textContent?.includes('安装') || btn.textContent?.includes('Install')) {
              btn.click();
              break;
            }
          }
        });
      }
    }

    // ========================================
    // 步骤 7: 获取 OAuth 回调 URL
    // ========================================
    console.log('\n🎯 步骤 7: 获取回调 URL');

    // 等待重定向到 YepAI
    await page.waitForURL(/yepai\.io|localhost/, { timeout: 60000 });

    const oauthCallbackUrl = page.url();

    console.log('\n' + '='.repeat(60));
    console.log('✅ 完成！OAuth 回调 URL:');
    console.log('='.repeat(60));
    console.log(oauthCallbackUrl);
    console.log('='.repeat(60));

    return oauthCallbackUrl;

  } catch (error) {
    console.error('\n❌ 错误:', error);

    // 截图保存
    await page.screenshot({ path: `screenshots/error_${Date.now()}.png`, fullPage: true });
    console.log('📸 错误截图已保存');

    throw error;
  } finally {
    // 输出结果后等待用户确认
    console.log('\n💡 按 Enter 关闭浏览器页面，或 Ctrl+C 保持打开');

    // 等待用户输入或超时
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => {
        cleanup().then(resolve);
      });
    });
  }
}

// 运行
createShopifyStoreAndGetOAuthUrl().catch(console.error);
