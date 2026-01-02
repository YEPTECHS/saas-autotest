# Shopify Store Create Skill

快速创建 Shopify 开发商店并获取 OAuth 回调 URL。

## 触发命令
- `/shopify-create`
- `/shopify:create`

## 执行流程

使用 Claude in Chrome MCP 工具执行以下步骤：

### 步骤 1: 初始化
```
1. 调用 tabs_context_mcp 获取 Chrome 标签页
2. 创建新标签页或使用现有标签页
3. 生成随机商店名称: yepai-test-XXXX
```

### 步骤 2: 创建商店 (单条 JS 命令)
```javascript
// 导航到: https://admin.shopify.com/store-create/organization/155064156
// 等待页面加载后执行:

// 使用 form_input 填写商店名称 (ref_4 通常是商店名称输入框)
// 使用 javascript_tool 选择套餐和勾选选项:
const select = document.querySelector('select');
select.value = 'BASIC_APP_DEVELOPMENT';
select.dispatchEvent(new Event('change', { bubbles: true }));

const checkbox = document.querySelector('input[type="checkbox"]');
if (checkbox && !checkbox.checked) checkbox.click();

// 点击创建按钮
document.querySelector('button[type="button"]').click();
```

### 步骤 3: OAuth 流程 (批量执行)
```javascript
// 导航到 OAuth URL 后，用 JS 直接点击商店和安装按钮:

// 选择商店
const storeName = 'yepai-test-XXXX';
document.querySelector(`a:has-text("${storeName}")`).click();

// 等待后点击安装
document.querySelector('button:has-text("安装")').click();
```

### 步骤 4: 获取回调 URL
```
等待重定向到 bot-test.yepai.io
获取当前 URL 并保存到:
- data/shopify-oauth-urls.json
- 输出到控制台
```

## 配置
```yaml
SHOPIFY_ORG_ID: 155064156
YEPAI_CLIENT_ID: 6f59e94645ee98a1ba5a77d17fc24d77
```

## 输出
```json
{
  "storeName": "yepai-test-3047",
  "storeUrl": "yepai-test-3047.myshopify.com",
  "oauthCallbackUrl": "https://bot-test.yepai.io/auth/external-register?code=xxx&shop=xxx",
  "createdAt": "2026-01-03T..."
}
```

## 后续步骤
获取到 OAuth URL 后，运行 registration flow:
```bash
pnpm flow registration --var OAUTH_URL="<callback_url>"
```
