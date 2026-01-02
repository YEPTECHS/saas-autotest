/**
 * Shopify Store Create Skill
 *
 * 快速创建 Shopify 开发商店并获取 OAuth 回调 URL
 *
 * 使用方法:
 * 1. 确保 Chrome 已打开并安装了 Claude in Chrome 扩展
 * 2. 运行: pnpm skill:shopify-create
 *
 * 或者在 Claude Code 中使用: /shopify-create
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ============================================
// 配置
// ============================================
const CONFIG = {
  SHOPIFY_ORG_ID: process.env.SHOPIFY_ORG_ID || '155064156',
  YEPAI_CLIENT_ID: process.env.YEPAI_CLIENT_ID || '6f59e94645ee98a1ba5a77d17fc24d77',
  STORE_CREATE_URL: 'https://admin.shopify.com/store-create/organization/',
  OAUTH_BASE_URL: 'https://admin.shopify.com/?organization_id=',
  DATA_FILE: join(process.cwd(), 'data/shopify-oauth-urls.json'),
};

// ============================================
// 数据存储
// ============================================
interface ShopifyOAuthRecord {
  storeName: string;
  storeUrl: string;
  oauthCallbackUrl: string;
  createdAt: string;
  used: boolean;
}

interface OAuthDataFile {
  records: ShopifyOAuthRecord[];
  lastUpdated: string;
}

function loadOAuthData(): OAuthDataFile {
  if (existsSync(CONFIG.DATA_FILE)) {
    return JSON.parse(readFileSync(CONFIG.DATA_FILE, 'utf-8'));
  }
  return { records: [], lastUpdated: new Date().toISOString() };
}

function saveOAuthRecord(record: ShopifyOAuthRecord): void {
  const data = loadOAuthData();
  data.records.unshift(record); // 最新的放前面
  data.lastUpdated = new Date().toISOString();

  // 确保目录存在
  const dir = join(process.cwd(), 'data');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
}

function getUnusedOAuthUrl(): ShopifyOAuthRecord | null {
  const data = loadOAuthData();
  return data.records.find(r => !r.used) || null;
}

function markOAuthUrlAsUsed(storeName: string): void {
  const data = loadOAuthData();
  const record = data.records.find(r => r.storeName === storeName);
  if (record) {
    record.used = true;
    data.lastUpdated = new Date().toISOString();
    writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
  }
}

// ============================================
// 生成 MCP 命令序列 (供 Claude 执行)
// ============================================
function generateStoreName(): string {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  return `yepai-test-${suffix}`;
}

function generateMCPCommands(storeName: string): string {
  return `
## Shopify Store Create - MCP 命令序列

执行以下步骤创建商店 "${storeName}":

### 1. 获取 Chrome 标签页
\`\`\`
mcp__claude-in-chrome__tabs_context_mcp({ createIfEmpty: true })
\`\`\`

### 2. 导航到商店创建页面
\`\`\`
mcp__claude-in-chrome__navigate({
  tabId: <TAB_ID>,
  url: "${CONFIG.STORE_CREATE_URL}${CONFIG.SHOPIFY_ORG_ID}"
})
\`\`\`

### 3. 等待页面加载 (3秒)
\`\`\`
mcp__claude-in-chrome__computer({ action: "wait", tabId: <TAB_ID>, duration: 3 })
\`\`\`

### 4. 读取页面元素
\`\`\`
mcp__claude-in-chrome__read_page({ tabId: <TAB_ID>, filter: "interactive" })
\`\`\`

### 5. 填写商店名称 (使用 form_input - 最可靠)
\`\`\`
mcp__claude-in-chrome__form_input({ tabId: <TAB_ID>, ref: "ref_4", value: "${storeName}" })
\`\`\`

### 6. 选择套餐和选项 (使用 JS - 最快)
\`\`\`javascript
mcp__claude-in-chrome__javascript_tool({
  action: "javascript_exec",
  tabId: <TAB_ID>,
  text: \`
    // 选择 Basic 套餐
    const select = document.querySelector('select');
    if (select) {
      select.value = 'BASIC_APP_DEVELOPMENT';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // 勾选测试数据
    const checkbox = document.querySelector('input[type="checkbox"]');
    if (checkbox && !checkbox.checked) checkbox.click();
    'done'
  \`
})
\`\`\`

### 7. 点击创建按钮
\`\`\`
mcp__claude-in-chrome__computer({ action: "left_click", tabId: <TAB_ID>, ref: "ref_6" })
\`\`\`

### 8. 等待商店创建 (检测 URL 变化，最多 60 秒)
\`\`\`
循环检查 URL 是否包含 /store/${storeName}
mcp__claude-in-chrome__computer({ action: "wait", tabId: <TAB_ID>, duration: 5 })
\`\`\`

### 9. 导航到 OAuth URL
\`\`\`
mcp__claude-in-chrome__navigate({
  tabId: <TAB_ID>,
  url: "${CONFIG.OAUTH_BASE_URL}${CONFIG.SHOPIFY_ORG_ID}&no_redirect=true&redirect=/oauth/redirect_from_developer_dashboard?client_id%3D${CONFIG.YEPAI_CLIENT_ID}"
})
\`\`\`

### 10. 选择商店 (使用 JS 点击)
\`\`\`javascript
mcp__claude-in-chrome__javascript_tool({
  action: "javascript_exec",
  tabId: <TAB_ID>,
  text: \`
    const links = document.querySelectorAll('a');
    for (const link of links) {
      if (link.textContent.includes('${storeName}')) {
        link.click();
        break;
      }
    }
    'clicked'
  \`
})
\`\`\`

### 11. 点击安装按钮
\`\`\`javascript
mcp__claude-in-chrome__javascript_tool({
  action: "javascript_exec",
  tabId: <TAB_ID>,
  text: \`
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.includes('安装') || btn.textContent.includes('Install')) {
        btn.click();
        break;
      }
    }
    'clicked'
  \`
})
\`\`\`

### 12. 等待重定向并获取 URL
\`\`\`
等待 URL 包含 yepai.io 或 localhost
获取完整 URL 作为 OAuth 回调地址
\`\`\`

### 13. 保存结果
将以下内容保存到 data/shopify-oauth-urls.json:
\`\`\`json
{
  "storeName": "${storeName}",
  "storeUrl": "${storeName}.myshopify.com",
  "oauthCallbackUrl": "<获取到的URL>",
  "createdAt": "${new Date().toISOString()}",
  "used": false
}
\`\`\`
`;
}

// ============================================
// CLI 入口
// ============================================
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Shopify Store Create Skill

用法:
  pnpm skill:shopify-create [options]

选项:
  --generate     生成 MCP 命令序列 (供 Claude 执行)
  --get-unused   获取一个未使用的 OAuth URL
  --list         列出所有已创建的商店
  --help         显示帮助

示例:
  pnpm skill:shopify-create --generate
  pnpm skill:shopify-create --get-unused
`);
    return;
  }

  if (args.includes('--generate')) {
    const storeName = generateStoreName();
    console.log(generateMCPCommands(storeName));
    return;
  }

  if (args.includes('--get-unused')) {
    const record = getUnusedOAuthUrl();
    if (record) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log('没有未使用的 OAuth URL，请先运行 /shopify-create 创建新商店');
    }
    return;
  }

  if (args.includes('--list')) {
    const data = loadOAuthData();
    console.log(`\n已创建的商店 (${data.records.length} 个):\n`);
    data.records.forEach((r, i) => {
      console.log(`${i + 1}. ${r.storeName}`);
      console.log(`   URL: ${r.storeUrl}`);
      console.log(`   状态: ${r.used ? '已使用' : '未使用'}`);
      console.log(`   创建: ${r.createdAt}\n`);
    });
    return;
  }

  // 默认: 生成命令
  const storeName = generateStoreName();
  console.log(generateMCPCommands(storeName));
}

// 导出函数供其他模块使用
export {
  CONFIG,
  generateStoreName,
  generateMCPCommands,
  saveOAuthRecord,
  getUnusedOAuthUrl,
  markOAuthUrlAsUsed,
  loadOAuthData,
};

main().catch(console.error);
