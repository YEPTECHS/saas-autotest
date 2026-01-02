/**
 * Claude MCP Tool Format
 * Export tools in Claude/Anthropic-compatible format
 */

import { tools, ToolDefinition } from './tool-definitions.js';

export interface ClaudeMCPTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Convert tool definition to Claude MCP format
 */
function toClaudeFormat(tool: ToolDefinition): ClaudeMCPTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

/**
 * Get all tools in Claude MCP format
 */
export function getClaudeTools(): ClaudeMCPTool[] {
  return Object.values(tools).map(toClaudeFormat);
}

/**
 * Get tools as JSON string
 */
export function getClaudeToolsJSON(): string {
  return JSON.stringify(getClaudeTools(), null, 2);
}

/**
 * MCP Server configuration for Claude Code
 */
export const mcpServerConfig = {
  name: 'yepai-e2e',
  description: 'YepAI E2E automation tools for browser testing and email verification',
  version: '1.0.0',
  tools: getClaudeTools(),
};

/**
 * Example MCP Server implementation
 */
export const exampleMCPServer = `
// mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getClaudeTools } from './claude-tools.js';
import { executeToolCall } from './executor.js';

const server = new Server(
  {
    name: 'yepai-e2e',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler('tools/list', async () => ({
  tools: getClaudeTools(),
}));

// Handle tool calls
server.setRequestHandler('tools/call', async (request) => {
  const { name, arguments: args } = request.params;
  const result = await executeToolCall(name, args);
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
});

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
`;

/**
 * Claude Code settings.json configuration
 */
export const claudeCodeSettings = {
  mcpServers: {
    'yepai-e2e': {
      command: 'node',
      args: ['dist/tools/mcp-server.js'],
      cwd: '/path/to/yepai-e2e-automation',
    },
  },
};

// Export tools object for direct access
export { tools };
