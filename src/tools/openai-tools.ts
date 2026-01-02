/**
 * OpenAI Function Calling Format
 * Export tools in OpenAI-compatible format
 */

import { tools, ToolDefinition } from './tool-definitions.js';

export interface OpenAIFunction {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

/**
 * Convert tool definition to OpenAI format
 */
function toOpenAIFormat(tool: ToolDefinition): OpenAIFunction {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Get all tools in OpenAI function calling format
 */
export function getOpenAITools(): OpenAIFunction[] {
  return Object.values(tools).map(toOpenAIFormat);
}

/**
 * Get tools as JSON string for embedding in prompts
 */
export function getOpenAIToolsJSON(): string {
  return JSON.stringify(getOpenAITools(), null, 2);
}

/**
 * Example usage with OpenAI SDK
 */
export const exampleUsage = `
import OpenAI from 'openai';
import { getOpenAITools } from 'yepai-e2e-automation/tools/openai-tools';
import { executeToolCall } from 'yepai-e2e-automation/tools/executor';

const openai = new OpenAI();

async function runWithTools(userMessage: string) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4',
    messages: [{ role: 'user', content: userMessage }],
    tools: getOpenAITools(),
  });

  const toolCalls = response.choices[0].message.tool_calls;

  if (toolCalls) {
    for (const call of toolCalls) {
      const result = await executeToolCall(
        call.function.name,
        JSON.parse(call.function.arguments)
      );
      console.log(\`Tool \${call.function.name} result:\`, result);
    }
  }
}

// Example: Run registration test
runWithTools('Run the registration flow with email test@gmail.com');
`;

// Export tools object for direct access
export { tools };
