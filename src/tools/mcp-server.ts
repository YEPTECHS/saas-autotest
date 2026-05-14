/**
 * YepAI E2E MCP Server
 *
 * Exposes browser automation + flow execution tools to Claude Code (or any MCP client).
 * Claude can directly navigate pages, click elements, run flows, and read results.
 *
 * Start:  pnpm mcp:server
 * Config: .mcp.json in project root points here automatically.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getClaudeTools } from './claude-tools.js';
import { executeToolCall } from './executor.js';
import 'dotenv/config';

const server = new Server(
  { name: 'yepai-e2e', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getClaudeTools(),
}));

// Execute a tool call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await executeToolCall(name, (args ?? {}) as Record<string, unknown>);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    isError: !result.success,
  };
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
