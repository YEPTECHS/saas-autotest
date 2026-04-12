# YepAI E2E Automation Framework

声明式 E2E 自动化框架，支持 YAML 流程定义、Gmail API 邮箱验证、Shopify OAuth 流程。

## 架构

```
┌─────────────────────────────────────────┐
│  Interface Layer (接口层)                │
│  - CLI: pnpm flow <name>                │
│  - Web UI: pnpm shopify:ui              │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Flow Definition (流程定义层)            │
│  - YAML 声明式配置                       │
│  - 变量插值 {{VAR}}                      │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Executor (执行引擎)                     │
│  - 解析 YAML → 执行 Actions              │
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Actions (原子操作层)                    │
│  - browser.*, form.*, gmail.*, log, wait│
└─────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────┐
│  Core (核心层)                           │
│  - Playwright 浏览器控制                 │
│  - Gmail API 邮件读取                    │
└─────────────────────────────────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
npx playwright install chromium
```

### 2. 配置环境变量

```bash
cp .env .env
# 编辑 .env 填写凭据
```

### 3. 运行流程

```bash
# 启动 Web UI
pnpm shopify:ui
# 访问 http://localhost:3456

# 或使用 CLI
pnpm flow shopify-oauth-registration --var OAUTH_URL="https://..."
```

## 可用流程

| 流程 | 描述 | 用法 |
|------|------|------|
| `registration` | 完整用户注册流程（表单、邮箱验证、问卷等） | `pnpm flow registration` |
| `shopify-store-create` | 创建 Shopify 开发店铺并获取 OAuth URL | `pnpm shopify:create` |
| `shopify-oauth-registration` | 通过 Shopify OAuth URL 完成 YepAI 注册 | `pnpm flow shopify-oauth-registration --var OAUTH_URL="..."` |

## 项目结构

```
yepai-e2e-automation/
├── src/
│   ├── core/              # 核心模块
│   │   ├── browser.ts     # Playwright 浏览器封装
│   │   ├── gmail.ts       # Gmail API 封装
│   │   ├── executor.ts    # 流程执行器
│   │   └── storage.ts     # 数据存储
│   ├── flows/             # YAML 流程定义
│   │   ├── shopify-store-create.flow.yml
│   │   └── shopify-oauth-registration.flow.yml
│   ├── actions/           # 原子操作
│   │   ├── auth/          # 认证相关
│   │   ├── gmail/         # 邮件相关
│   │   └── shopify/       # Shopify 相关
│   ├── tools/             # AI 工具定义
│   ├── cli/               # CLI 入口
│   └── web/               # Web UI 服务器
├── skills/                # Claude Code Skills
├── data/                  # 运行时数据 (OAuth URLs)
├── docs/                  # 文档
└── scripts/               # 辅助脚本
```

## 环境变量

```env
# YepAI 测试环境
YEPAI_BASE_URL=https://bot-test.yepai.io
YEPAI_TEST_EMAIL=test@gmail.com
YEPAI_TEST_PASSWORD=SecurePassword123!
YEPAI_TEST_FIRST_NAME=Test
YEPAI_TEST_LAST_NAME=User

# Gmail API (用于获取验证码)
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx

# Shopify Partner (用于创建开发店铺)
SHOPIFY_PARTNER_EMAIL=partner@email.com
SHOPIFY_PARTNER_PASSWORD=xxx
```

详细设置指南:
- [Gmail API 设置](docs/setup-gmail-api.md)
- [Shopify 开发者设置](docs/setup-shopify-dev.md)

## CLI 命令

```bash
# 流程执行
pnpm flow <flowName> [options]
pnpm flow shopify-oauth-registration --var OAUTH_URL="..."

# Shopify 相关
pnpm shopify:ui          # 启动 Web UI
pnpm shopify:create      # 创建开发店铺 (CDP 模式)
pnpm shopify:create:fast # 快速创建 (直接 API)

# 选项
--var KEY=VALUE    # 设置变量
--headless         # 无头模式
--slow-mo <ms>     # 慢动作模式
```

## 流程编写

### YAML 流程示例

```yaml
name: my-flow
description: 自定义流程

steps:
  - id: navigate
    action: browser.navigate
    params:
      url: "{{YEPAI_BASE_URL}}/login"

  - id: fill-form
    action: form.fillSingle
    params:
      selector: "#email"
      value: "{{YEPAI_TEST_EMAIL}}"

  - id: submit
    action: browser.click
    params:
      selector: "button[type='submit']"

  - id: wait-redirect
    action: browser.waitForUrl
    params:
      pattern: "dashboard"
      timeout: 30000

  - id: get-code
    action: gmail.getVerificationCode
    params:
      to: "{{YEPAI_TEST_EMAIL}}"
      subject: "verification"
      codePattern: "\\d{6}"
    output: verificationResult
```

### 可用 Actions

| Action | 描述 |
|--------|------|
| `browser.navigate` | 导航到 URL |
| `browser.click` | 点击元素 |
| `browser.execute` | 执行 JavaScript |
| `browser.waitForSelector` | 等待元素出现 |
| `browser.waitForUrl` | 等待 URL 匹配 |
| `browser.screenshot` | 截图 |
| `form.fillSingle` | 填写单个表单字段 |
| `form.fillVerificationCode` | 填写验证码 |
| `gmail.getVerificationCode` | 从 Gmail 获取验证码 |
| `wait` | 等待指定毫秒 |
| `log` | 打印日志 |

## AI 集成

本框架设计为可被任何支持 tool calling 的 AI 执行:

### Claude Code Skills

```bash
cp -r skills/* ~/.claude/skills/
```

### OpenAI / Claude API

```typescript
import { getOpenAITools } from './src/tools/openai-tools';
import { getClaudeTools } from './src/tools/claude-tools';

// 获取工具定义用于 AI API 调用
const tools = getOpenAITools(); // or getClaudeTools()
```

详见 [AI 集成指南](docs/ai-integration-guide.md)

## 开发

```bash
# 类型检查
pnpm tsc --noEmit

# 开发模式运行
pnpm tsx src/cli/index.ts flow <name>
```

## License

MIT
