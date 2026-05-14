/**
 * Universal AI Tool Definitions
 * Compatible with both OpenAI Function Calling and Claude MCP
 */

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

/**
 * Core E2E Automation Tools
 */
export const tools: Record<string, ToolDefinition> = {
  // Flow execution
  runFlow: {
    name: 'run_e2e_flow',
    description: 'Execute an E2E test flow by name. Call list_flows first to see all available flows.',
    parameters: {
      type: 'object',
      properties: {
        flowName: {
          type: 'string',
          description: 'Name of the flow to execute (without .flow.yml). Use list_flows to discover available flows.',
        },
        variables: {
          type: 'object',
          description: 'Variables to override in the flow (e.g., testEmail, shopifyStore)',
          properties: {},
        },
        headless: {
          type: 'boolean',
          default: false,
          description: 'Run browser in headless mode (no visible window)',
        },
        slowMo: {
          type: 'number',
          default: 100,
          description: 'Slow down operations by this many milliseconds',
        },
      },
      required: ['flowName'],
    },
  },

  // Gmail verification
  getGmailVerificationCode: {
    name: 'get_gmail_verification_code',
    description: 'Fetch the latest verification code from Gmail. Useful for email verification flows.',
    parameters: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address to check for verification codes',
        },
        subject: {
          type: 'string',
          description: 'Email subject to filter by (partial match)',
        },
        codePattern: {
          type: 'string',
          default: '\\d{6}',
          description: 'Regex pattern to extract verification code',
        },
        timeout: {
          type: 'number',
          default: 60000,
          description: 'Maximum time to wait for email in milliseconds',
        },
      },
      required: ['email'],
    },
  },

  // Browser navigation
  browserNavigate: {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to navigate to',
        },
      },
      required: ['url'],
    },
  },

  // Browser click
  browserClick: {
    name: 'browser_click',
    description: 'Click an element on the page',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector or text selector (e.g., "button:has-text(\'Submit\')")',
        },
        waitForNavigation: {
          type: 'boolean',
          default: false,
          description: 'Wait for page navigation after click',
        },
      },
      required: ['selector'],
    },
  },

  // Browser type
  browserType: {
    name: 'browser_type',
    description: 'Type text into an input field',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the input element',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        clear: {
          type: 'boolean',
          default: true,
          description: 'Clear the field before typing',
        },
      },
      required: ['selector', 'text'],
    },
  },

  // Fill form
  browserFillForm: {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields at once',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description: 'Object mapping field names/IDs to values',
          properties: {},
        },
      },
      required: ['fields'],
    },
  },

  // Take screenshot
  browserScreenshot: {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current page',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File path to save screenshot (optional)',
        },
        fullPage: {
          type: 'boolean',
          default: true,
          description: 'Capture full page or just viewport',
        },
      },
    },
  },

  // Wait for selector
  browserWaitFor: {
    name: 'browser_wait_for',
    description: 'Wait for an element to appear on the page',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector to wait for',
        },
        timeout: {
          type: 'number',
          default: 30000,
          description: 'Maximum time to wait in milliseconds',
        },
        state: {
          type: 'string',
          enum: ['visible', 'attached', 'hidden'],
          default: 'visible',
          description: 'State to wait for',
        },
      },
      required: ['selector'],
    },
  },

  // Wait for URL
  browserWaitForUrl: {
    name: 'browser_wait_for_url',
    description: 'Wait for the URL to match a pattern',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'URL pattern (regex) to wait for',
        },
        timeout: {
          type: 'number',
          default: 30000,
          description: 'Maximum time to wait in milliseconds',
        },
      },
      required: ['pattern'],
    },
  },

  // Get current URL
  browserGetUrl: {
    name: 'browser_get_url',
    description: 'Get the current page URL',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  // Get page text
  browserGetText: {
    name: 'browser_get_text',
    description: 'Get text content of an element',
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS selector for the element',
        },
      },
      required: ['selector'],
    },
  },

  // Close browser
  browserClose: {
    name: 'browser_close',
    description: 'Close the browser instance',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  // List available flows
  listFlows: {
    name: 'list_flows',
    description: 'List all available E2E test flows',
    parameters: {
      type: 'object',
      properties: {},
    },
  },

  // Get flow details
  getFlowDetails: {
    name: 'get_flow_details',
    description: 'Get detailed information about a specific flow',
    parameters: {
      type: 'object',
      properties: {
        flowName: {
          type: 'string',
          description: 'Name of the flow to get details for',
        },
      },
      required: ['flowName'],
    },
  },

  // Generate a new flow from natural language
  generateFlow: {
    name: 'generate_flow',
    description: 'Generate a new YAML flow test file from a natural language description. Claude writes the flow and saves it to src/flows/ ready to run.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Natural language description of what to test (e.g. "test that a logged-in user can open the marketing chat and send a message")',
        },
        flowName: {
          type: 'string',
          description: 'Output file name in kebab-case without .flow.yml (e.g. test-marketing-send-message)',
        },
      },
      required: ['prompt', 'flowName'],
    },
  },

  // Analyse a screenshot with Claude Vision
  analyzeScreenshot: {
    name: 'analyze_screenshot',
    description: 'Use Claude Vision to analyse a screenshot and check whether the page looks correct. Returns pass/fail and a list of any visual issues.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the screenshot file (PNG or JPEG)',
        },
        description: {
          type: 'string',
          description: 'Optional context — what page or feature this screenshot shows',
        },
      },
      required: ['path'],
    },
  },
};

/**
 * Get all tools as array
 */
export function getAllTools(): ToolDefinition[] {
  return Object.values(tools);
}

/**
 * Get tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
  return tools[name];
}
