# AI Integration Guide

This guide explains how to integrate the YepAI E2E Automation framework with different AI assistants.

## Overview

The framework provides tools in multiple formats:
- **OpenAI Function Calling** - For GPT-4, GPT-3.5
- **Claude MCP** - For Claude Code and Anthropic API
- **Universal JSON Schema** - For any AI with tool support

## Claude Code Integration

### Method 1: Using Skills

Copy the skills to your Claude configuration:

```bash
cp -r skills/* ~/.claude/skills/
```

Skills will auto-activate based on triggers:
- "register new user" → `yepai-register`
- "install shopify app" → `yepai-shopify-install`
- "run full e2e test" → `yepai-full-e2e`

### Method 2: Using MCP Server

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "yepai-e2e": {
      "command": "node",
      "args": ["dist/tools/mcp-server.js"],
      "cwd": "/Users/i7ove/Documents/YepAI/yepai-e2e-automation"
    }
  }
}
```

### Method 3: Direct Tool Calls

In Claude Code, you can call tools directly:

```
User: Run the registration flow for test@gmail.com

Claude: I'll execute the registration flow using the E2E automation tools.

[Tool Call: run_e2e_flow]
{
  "flowName": "registration",
  "variables": {
    "testEmail": "test@gmail.com"
  }
}
```

## OpenAI Integration

### Setup

```typescript
import OpenAI from 'openai';
import { getOpenAITools } from 'yepai-e2e-automation/tools/openai-tools';
import { executeToolCall } from 'yepai-e2e-automation/tools/executor';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function runWithE2E(prompt: string) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4-turbo',
    messages: [
      {
        role: 'system',
        content: 'You are a QA automation assistant. Use the available tools to run E2E tests.'
      },
      { role: 'user', content: prompt }
    ],
    tools: getOpenAITools(),
    tool_choice: 'auto',
  });

  const message = response.choices[0].message;

  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      const result = await executeToolCall(
        call.function.name,
        JSON.parse(call.function.arguments)
      );
      console.log(`Tool ${call.function.name}:`, result);
    }
  }

  return message;
}

// Usage
runWithE2E('Please run the full onboarding test');
```

### Streaming with Tools

```typescript
const stream = await openai.chat.completions.create({
  model: 'gpt-4-turbo',
  messages: [...],
  tools: getOpenAITools(),
  stream: true,
});

for await (const chunk of stream) {
  // Handle streaming tool calls
}
```

## Anthropic Claude API Integration

### Direct API Usage

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { getClaudeTools } from 'yepai-e2e-automation/tools/claude-tools';
import { executeToolCall } from 'yepai-e2e-automation/tools/executor';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function runWithClaude(prompt: string) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    tools: getClaudeTools(),
    messages: [{ role: 'user', content: prompt }],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use') {
      const result = await executeToolCall(block.name, block.input);
      console.log(`Tool ${block.name}:`, result);
    }
  }

  return response;
}
```

## LangChain Integration

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { DynamicTool } from '@langchain/core/tools';
import { executeToolCall } from 'yepai-e2e-automation/tools/executor';
import { tools } from 'yepai-e2e-automation/tools/tool-definitions';

// Convert to LangChain tools
const langchainTools = Object.entries(tools).map(([key, def]) =>
  new DynamicTool({
    name: def.name,
    description: def.description,
    func: async (input: string) => {
      const args = JSON.parse(input);
      const result = await executeToolCall(def.name, args);
      return JSON.stringify(result);
    },
  })
);

const model = new ChatOpenAI({ model: 'gpt-4' });
const modelWithTools = model.bind({ tools: langchainTools });
```

## Custom AI Integration

### Generic Tool Schema

```typescript
import { tools } from 'yepai-e2e-automation/tools/tool-definitions';
import { executeToolCall } from 'yepai-e2e-automation/tools/executor';

// Get all tools as JSON
const toolsJSON = JSON.stringify(tools, null, 2);

// Parse AI response and execute
function handleAIResponse(response: string) {
  // Your AI returns something like:
  // { "tool": "run_e2e_flow", "args": { "flowName": "registration" } }

  const { tool, args } = JSON.parse(response);
  return executeToolCall(tool, args);
}
```

## Available Tools Reference

| Tool | Description |
|------|-------------|
| `run_e2e_flow` | Execute predefined flow |
| `get_gmail_verification_code` | Get email verification code |
| `browser_navigate` | Navigate to URL |
| `browser_click` | Click element |
| `browser_type` | Type text |
| `browser_fill_form` | Fill form fields |
| `browser_screenshot` | Take screenshot |
| `browser_wait_for` | Wait for element |
| `browser_wait_for_url` | Wait for URL |
| `browser_get_url` | Get current URL |
| `browser_get_text` | Get element text |
| `browser_close` | Close browser |
| `list_flows` | List available flows |
| `get_flow_details` | Get flow info |

## Best Practices

### 1. Error Handling

```typescript
const result = await executeToolCall('run_e2e_flow', args);

if (!result.success) {
  // Handle error
  console.error('Tool failed:', result.error);
  // Optionally retry or ask user
}
```

### 2. Progress Updates

For long-running flows, provide updates:

```typescript
// In your AI system prompt:
"When running E2E tests, provide progress updates after each major step."
```

### 3. Screenshot Verification

Use screenshots to verify state:

```typescript
// After each critical step
await executeToolCall('browser_screenshot', { path: 'step_1.png' });
```

### 4. Cleanup

Always clean up browser:

```typescript
try {
  await executeToolCall('run_e2e_flow', args);
} finally {
  await executeToolCall('browser_close', {});
}
```

## Example Prompts

### For Registration Testing
```
Run the registration flow with:
- Email: newuser@gmail.com
- First name: Test
- Last name: User
- Organization: ACME Corp
```

### For Shopify Integration
```
Test the Shopify app installation on store my-store.myshopify.com
```

### For Full E2E
```
Run the complete onboarding test with default settings, capture screenshots at each phase
```
