---
name: yepai-shopify-install
description: Install YepAI app on Shopify store via OAuth flow. Triggers on "install shopify app", "shopify oauth", "connect shopify store", "test shopify integration".
version: 1.0.0
---

# Shopify App Installation Automation

This skill automates the complete Shopify OAuth app installation flow for YepAI.

## Capabilities

- Navigate to YepAI integration page
- Initiate Shopify OAuth flow
- Handle Shopify partner login
- Authorize app permissions
- Complete billing/plan selection
- Verify successful installation

## Prerequisites

### 1. User Must Be Logged In
Run `yepai-register` first or ensure user is authenticated.

### 2. Shopify Partner Account
You need a Shopify Partner account with a development store.

### 3. Environment Variables
```env
SHOPIFY_STORE_URL=your-dev-store.myshopify.com
SHOPIFY_EMAIL=partner@example.com
SHOPIFY_PASSWORD=your-password
SHOPIFY_SELECTED_PLAN=basic
```

## Usage

### Via CLI
```bash
cd /Users/i7ove/Documents/YepAI/yepai-e2e-automation
pnpm run flow shopify-install
```

### Via AI Tool Call
```json
{
  "tool": "run_e2e_flow",
  "arguments": {
    "flowName": "shopify-install",
    "variables": {
      "shopifyStore": "my-store.myshopify.com"
    }
  }
}
```

## Flow Steps

1. `navigate-integration` - Go to /installation page
2. `click-shopify-tab` - Select Shopify integration tab
3. `click-install-button` - Start OAuth flow
4. `wait-shopify-domain` - Wait for redirect to Shopify
5. `enter-store-url` - Enter store URL if prompted
6. `fill-shopify-email/password` - Login to Shopify
7. `authorize-app` - Grant app permissions
8. `wait-callback` - Wait for OAuth callback
9. `select-plan` - Choose billing plan
10. `verify-installation` - Confirm success

## OAuth Flow Details

```
YepAI App                    Shopify
    |                           |
    |-- Click Install --------->|
    |                           |
    |<-- Redirect to OAuth -----|
    |                           |
    |-- User Login ------------>|
    |                           |
    |-- Authorize App --------->|
    |                           |
    |<-- Callback with code ----|
    |                           |
    |-- Exchange code --------->|
    |                           |
    |<-- Access Token ----------|
    |                           |
    |-- App Installed! ---------|
```

## Troubleshooting

### OAuth redirect fails
- Verify app is properly configured in Shopify Partners
- Check callback URL matches YepAI settings

### Login fails
- Verify Shopify credentials
- Check for 2FA requirements (may need manual intervention)

### Authorization timeout
- Increase timeout in flow configuration
- Check network connectivity

### Plan selection fails
- Verify selected plan is available
- Check Shopify billing is enabled for dev store
