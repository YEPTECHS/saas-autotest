# YepAI E2E Automation Framework

AI-driven end-to-end automation framework for YepAI testing. Supports email verification via Gmail API, Shopify OAuth flows, and integration with multiple AI assistants.

## Features

- **Flow-based Testing** - YAML-defined test flows that are human-readable and AI-parseable
- **Gmail Integration** - Automated email verification code retrieval
- **Shopify OAuth** - Complete app installation automation
- **AI Tool Support** - Works with Claude, GPT-4, and any AI with tool calling
- **Claude Skills** - Ready-to-use skills for Claude Code

## Quick Start

### 1. Install Dependencies

```bash
cd /Users/i7ove/Documents/YepAI/yepai-e2e-automation
pnpm install
npx playwright install chromium
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Run a Flow

```bash
# List available flows
pnpm run flow list

# Run registration flow
pnpm run flow run registration

# Run with custom email
pnpm run flow run registration --email "test@gmail.com"

# Run Shopify installation
pnpm run flow run shopify-install

# Run full onboarding
pnpm run flow run full-onboarding
```

## Available Flows

| Flow | Description |
|------|-------------|
| `registration` | User signup with email verification |
| `shopify-install` | Shopify OAuth app installation |
| `full-onboarding` | Complete user journey |

## Project Structure

```
yepai-e2e-automation/
├── src/
│   ├── core/           # Core modules (browser, gmail, executor)
│   ├── flows/          # YAML flow definitions
│   ├── tools/          # AI tool definitions
│   └── cli/            # Command-line interface
├── skills/             # Claude Code skills
├── docs/               # Setup guides
└── tests/              # Test files
```

## Configuration

### Environment Variables

```env
# YepAI
YEPAI_BASE_URL=https://app.yepai.io
YEPAI_TEST_EMAIL=test@gmail.com
YEPAI_TEST_PASSWORD=SecurePassword123!

# Gmail API
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx

# Shopify
SHOPIFY_STORE_URL=store.myshopify.com
SHOPIFY_EMAIL=partner@email.com
SHOPIFY_PASSWORD=xxx
```

See [docs/setup-gmail-api.md](docs/setup-gmail-api.md) for Gmail setup.
See [docs/setup-shopify-dev.md](docs/setup-shopify-dev.md) for Shopify setup.

## AI Integration

### Claude Code Skills

Copy skills to your Claude configuration:

```bash
cp -r skills/* ~/.claude/skills/
```

Then use natural language:
- "Register a new test user"
- "Install the Shopify app"
- "Run the full E2E test"

### OpenAI / GPT-4

```typescript
import { getOpenAITools } from 'yepai-e2e-automation/tools/openai-tools';

const tools = getOpenAITools();
// Use with OpenAI API
```

### Claude API

```typescript
import { getClaudeTools } from 'yepai-e2e-automation/tools/claude-tools';

const tools = getClaudeTools();
// Use with Anthropic API
```

See [docs/ai-integration-guide.md](docs/ai-integration-guide.md) for detailed integration examples.

## CLI Commands

```bash
# Run a flow
pnpm run flow run <flowName> [options]

# List flows
pnpm run flow list

# Get flow details
pnpm run flow info <flowName>

# Execute single tool
pnpm run flow tool <toolName> --args '{"key":"value"}'
```

### Options

| Option | Description |
|--------|-------------|
| `-e, --email` | Override test email |
| `-h, --headless` | Run in headless mode |
| `-s, --slow-mo` | Slow down (ms) |
| `--var key=value` | Set variables |

## Creating Custom Flows

Create a new `.flow.yml` file in `src/flows/`:

```yaml
name: my-custom-flow
description: My custom test flow

variables:
  baseUrl: "{{YEPAI_BASE_URL}}"

steps:
  - id: step-1
    action: browser.navigate
    params:
      url: "{{baseUrl}}/some-page"

  - id: step-2
    action: browser.click
    params:
      selector: "button.submit"
```

### Available Actions

- `browser.navigate`, `browser.click`, `browser.type`
- `form.fill`, `browser.waitForSelector`, `browser.waitForUrl`
- `gmail.waitForEmail`, `gmail.extractCode`
- `assert.url`, `assert.element`, `assert.text`
- `wait`, `log`, `setVariable`

## Development

```bash
# Development mode
pnpm dev

# Build
pnpm build

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## License

MIT
