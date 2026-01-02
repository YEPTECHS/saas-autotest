/**
 * Playwright Browser Manager
 * Handles browser lifecycle, page creation, and common browser operations
 */

import { chromium, Browser, BrowserContext, Page, Locator } from '@playwright/test';

export interface BrowserConfig {
  headless?: boolean;
  slowMo?: number;
  timeout?: number;
  viewport?: { width: number; height: number };
  screenshotOnFailure?: boolean;
  // 使用已有 Chrome 用户数据目录（保留登录状态）
  userDataDir?: string;
  // 连接到已运行的 Chrome 实例
  cdpUrl?: string;
}

export interface PopupHandler {
  page: Page;
  waitForClose: () => Promise<void>;
}

const DEFAULT_CONFIG: BrowserConfig = {
  headless: false,
  slowMo: 100,
  timeout: 30000,
  viewport: { width: 1280, height: 720 },
  screenshotOnFailure: true,
};

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: BrowserConfig;
  private popups: Map<string, Page> = new Map();

  constructor(config: Partial<BrowserConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize browser instance
   * 支持三种模式：
   * 1. 普通模式：启动新的浏览器实例
   * 2. 用户目录模式：使用已有 Chrome 配置文件（保留登录状态）
   * 3. CDP 模式：连接到已运行的 Chrome 实例
   */
  async init(): Promise<void> {
    if (this.config.cdpUrl) {
      // 模式 3: 连接到已运行的 Chrome（需要 Chrome 以 --remote-debugging-port 启动）
      this.browser = await chromium.connectOverCDP(this.config.cdpUrl);
      const contexts = this.browser.contexts();
      this.context = contexts[0] || await this.browser.newContext();
      const pages = this.context.pages();
      this.page = pages[0] || await this.context.newPage();
    } else if (this.config.userDataDir) {
      // 模式 2: 使用已有用户数据目录（保留 cookies、登录状态等）
      this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
        headless: this.config.headless,
        slowMo: this.config.slowMo,
        viewport: this.config.viewport,
        channel: 'chrome', // 使用系统安装的 Chrome
      });
      this.browser = null; // persistent context 没有单独的 browser 对象
      const pages = this.context.pages();
      this.page = pages[0] || await this.context.newPage();
    } else {
      // 模式 1: 普通模式，启动新的浏览器实例
      this.browser = await chromium.launch({
        headless: this.config.headless,
        slowMo: this.config.slowMo,
      });

      this.context = await this.browser.newContext({
        viewport: this.config.viewport,
      });

      this.page = await this.context.newPage();
    }

    this.context!.setDefaultTimeout(this.config.timeout!);

    // Listen for popup windows
    this.context!.on('page', (popup) => {
      const popupId = `popup_${Date.now()}`;
      this.popups.set(popupId, popup);
      popup.on('close', () => this.popups.delete(popupId));
    });
  }

  /**
   * Get the main page
   */
  getPage(): Page {
    if (!this.page) throw new Error('Browser not initialized. Call init() first.');
    return this.page;
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string): Promise<void> {
    const page = this.getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  /**
   * Click element
   */
  async click(selector: string, options?: { waitForNavigation?: boolean }): Promise<void> {
    const page = this.getPage();

    if (options?.waitForNavigation) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle' }),
        page.click(selector),
      ]);
    } else {
      await page.click(selector);
    }
  }

  /**
   * Type text into element
   */
  async type(selector: string, text: string, options?: { clear?: boolean }): Promise<void> {
    const page = this.getPage();
    const element = page.locator(selector);

    if (options?.clear) {
      await element.clear();
    }
    await element.fill(text);
  }

  /**
   * Fill form fields
   */
  async fillForm(fields: Record<string, string>): Promise<void> {
    const page = this.getPage();

    for (const [name, value] of Object.entries(fields)) {
      // Try different selectors
      const selectors = [
        `input[name="${name}"]`,
        `input[id="${name}"]`,
        `textarea[name="${name}"]`,
        `[data-testid="${name}"]`,
        `#${name}`,
      ];

      let filled = false;
      for (const selector of selectors) {
        try {
          const element = page.locator(selector);
          if (await element.count() > 0) {
            await element.fill(value);
            filled = true;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!filled) {
        console.warn(`Could not find field: ${name}`);
      }
    }
  }

  /**
   * Wait for selector
   */
  async waitFor(selector: string, options?: { timeout?: number; state?: 'visible' | 'attached' | 'hidden' }): Promise<Locator> {
    const page = this.getPage();
    const locator = page.locator(selector);
    await locator.waitFor({
      timeout: options?.timeout || this.config.timeout,
      state: options?.state || 'visible'
    });
    return locator;
  }

  /**
   * Wait for URL pattern
   */
  async waitForUrl(pattern: string | RegExp, timeout?: number): Promise<void> {
    const page = this.getPage();
    await page.waitForURL(pattern, { timeout: timeout || this.config.timeout });
  }

  /**
   * Get current URL
   */
  getCurrentUrl(): string {
    return this.getPage().url();
  }

  /**
   * Take screenshot
   */
  async screenshot(path?: string): Promise<Buffer> {
    const page = this.getPage();
    const screenshotPath = path || `screenshots/screenshot_${Date.now()}.png`;
    return page.screenshot({ path: screenshotPath, fullPage: true });
  }

  /**
   * Get page text content
   */
  async getTextContent(selector: string): Promise<string | null> {
    const page = this.getPage();
    return page.locator(selector).textContent();
  }

  /**
   * Check if element exists
   */
  async elementExists(selector: string): Promise<boolean> {
    const page = this.getPage();
    return (await page.locator(selector).count()) > 0;
  }

  /**
   * Capture popup window
   */
  async capturePopup(action: () => Promise<void>): Promise<PopupHandler> {
    const context = this.context;
    if (!context) throw new Error('Browser context not initialized');

    const popupPromise = context.waitForEvent('page');
    await action();
    const popup = await popupPromise;

    return {
      page: popup,
      waitForClose: async () => {
        await popup.waitForEvent('close');
      },
    };
  }

  /**
   * Get latest popup
   */
  getLatestPopup(): Page | undefined {
    const popups = Array.from(this.popups.values());
    return popups[popups.length - 1];
  }

  /**
   * Execute JavaScript in page context
   */
  async evaluate<T>(fn: () => T): Promise<T> {
    const page = this.getPage();
    return page.evaluate(fn);
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    } else if (this.context) {
      // For persistent context, close the context directly
      await this.context.close();
    }
    this.context = null;
    this.page = null;
    this.popups.clear();
  }

  /**
   * Create action result for AI tool response
   */
  createActionResult(success: boolean, data?: unknown, error?: string) {
    return {
      success,
      data,
      error,
      timestamp: new Date().toISOString(),
      url: this.page?.url(),
    };
  }
}

// Singleton instance for convenience
let defaultBrowser: BrowserManager | null = null;

export async function getBrowser(config?: Partial<BrowserConfig>): Promise<BrowserManager> {
  if (!defaultBrowser) {
    defaultBrowser = new BrowserManager(config);
    await defaultBrowser.init();
  }
  return defaultBrowser;
}

export async function closeBrowser(): Promise<void> {
  if (defaultBrowser) {
    await defaultBrowser.close();
    defaultBrowser = null;
  }
}
