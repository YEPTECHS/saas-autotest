/**
 * YepAI Page Selectors Configuration
 * Pre-recorded selectors for fast element location
 *
 * Last updated: 2026-01-02
 * Source: bot-test.yepai.io
 */

export const selectors = {
  // ==========================================
  // Registration Page (/auth/register)
  // ==========================================
  register: {
    // Form fields
    firstName: "input[placeholder='Enter your first name']",
    lastName: "input[placeholder='Enter your last name']",
    organization: "input[placeholder='Enter your organization']",
    email: "input[placeholder='Enter your email']",
    password: "input[type='password']:nth-of-type(1)",
    confirmPassword: "input[type='password']:nth-of-type(2)",

    // Buttons
    submitButton: "button[type='submit']",
    googleSignIn: "button:has-text('Sign in with Google')",
    signInLink: "button:has-text('Sign in')",

    // Validation messages
    passwordsMatch: "text=Passwords match!",
    emailValid: "input[placeholder='Enter your email'] + * svg", // checkmark
  },

  // ==========================================
  // Login Page (/auth/login)
  // ==========================================
  login: {
    email: "input[placeholder='Enter your email'], input[type='email']",
    password: "input[type='password']",
    submitButton: "button[type='submit']:has-text('Log In')",
    googleSignIn: "button:has-text('Continue with Google')",
    createAccountLink: "button:has-text('Create your account'), a:has-text('Create your account')",
    forgotPassword: "button:has-text('Forgot password'), a:has-text('Forgot password')",
  },

  // ==========================================
  // Email Verification Page
  // ==========================================
  verification: {
    // 6-digit code inputs
    codeInputs: "input[type='tel']",
    codeInput1: "input[type='tel']:nth-of-type(1)",
    codeInput2: "input[type='tel']:nth-of-type(2)",
    codeInput3: "input[type='tel']:nth-of-type(3)",
    codeInput4: "input[type='tel']:nth-of-type(4)",
    codeInput5: "input[type='tel']:nth-of-type(5)",
    codeInput6: "input[type='tel']:nth-of-type(6)",

    // Buttons
    resendCode: "button:has-text('Resend code')",

    // Text
    emailSentTo: "text=Please enter your verification code sent to",
  },

  // ==========================================
  // Platform Selection Page (/platform-selection)
  // ==========================================
  platformSelection: {
    // Platform options
    shopify: "[class*='border']:has-text('Shopify')",
    shopifyRadio: "[class*='border']:has-text('Shopify') input[type='radio'], [class*='border']:has-text('Shopify') [role='radio']",
    otherPlatforms: "[class*='border']:has-text('Other Platforms')",
    otherPlatformsRadio: "[class*='border']:has-text('Other Platforms') input[type='radio']",

    // Continue button
    continueButton: "button:has-text('Continue')",

    // Info badges
    oneClickInstallation: "text=One-click installation",
    activeStores: "text=1.7M+ active stores",
  },

  // ==========================================
  // Shopify Integration Page (/installation)
  // ==========================================
  shopifyIntegration: {
    // Tabs
    manualTab: "[data-tab='manual'], button:has-text('Manual')",
    shopifyTab: "[data-tab='shopify'], button:has-text('Shopify')",

    // Install button
    installButton: "button:has-text('Install'), button:has-text('Connect')",

    // Status indicators
    connectedStatus: "[data-status='connected'], text=Connected",
    disconnectedStatus: "[data-status='disconnected']",
  },

  // ==========================================
  // Shopify OAuth Pages (external)
  // ==========================================
  shopifyOAuth: {
    // Store URL input
    storeUrlInput: "input[name='shop'], input[placeholder*='store']",

    // Login form
    emailInput: "input[name='account[email]'], input[type='email']",
    passwordInput: "input[name='account[password]'], input[type='password']",
    continueButton: "button[type='submit']:has-text('Continue'), button:has-text('Next')",
    loginButton: "button[type='submit']:has-text('Log in')",

    // Authorization
    installAppButton: "button:has-text('Install app'), button:has-text('Install')",
    approveButton: "button:has-text('Approve')",
  },

  // ==========================================
  // Common Elements
  // ==========================================
  common: {
    // Update banner
    updateBanner: "text=A new version is available",
    updateNowButton: "button:has-text('Update now')",

    // Loading states
    spinner: "[class*='spinner'], [class*='loading']",
    skeleton: "[class*='skeleton']",

    // Toast notifications
    toast: "[class*='toast'], [role='alert']",
    successToast: "[class*='toast'][class*='success']",
    errorToast: "[class*='toast'][class*='error']",
  },

  // ==========================================
  // Dashboard Elements
  // ==========================================
  dashboard: {
    sidebar: "[class*='sidebar'], nav",
    mainContent: "main, [class*='content']",
    userMenu: "[class*='avatar'], [class*='user-menu']",
    logoutButton: "button:has-text('Logout'), button:has-text('Sign out')",
  },
};

/**
 * Get selector by path (e.g., "register.firstName")
 */
export function getSelector(path: string): string {
  const parts = path.split('.');
  let current: unknown = selectors;

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      throw new Error(`Selector not found: ${path}`);
    }
  }

  if (typeof current !== 'string') {
    throw new Error(`Invalid selector path: ${path}`);
  }

  return current;
}

/**
 * URLs configuration
 */
export const urls = {
  test: {
    base: 'https://bot-test.yepai.io',
    register: 'https://bot-test.yepai.io/auth/register',
    login: 'https://bot-test.yepai.io/auth/login',
    platformSelection: 'https://bot-test.yepai.io/platform-selection',
    installation: 'https://bot-test.yepai.io/installation',
    dashboard: 'https://bot-test.yepai.io/dashboard',
  },
  production: {
    base: 'https://app.yepai.io',
    register: 'https://app.yepai.io/auth/register',
    login: 'https://app.yepai.io/auth/login',
    platformSelection: 'https://app.yepai.io/platform-selection',
    installation: 'https://app.yepai.io/installation',
    dashboard: 'https://app.yepai.io/dashboard',
  },
};

export type Environment = 'test' | 'production';

export function getUrl(env: Environment, page: keyof typeof urls.test): string {
  return urls[env][page];
}
