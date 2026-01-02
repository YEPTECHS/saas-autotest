# Shopify Development Store Setup Guide

This guide explains how to set up a Shopify development store for E2E testing of the YepAI app installation.

## Prerequisites

- Shopify Partner account (free)
- YepAI app configured in Shopify Partners

## Step 1: Create Shopify Partner Account

1. Go to [Shopify Partners](https://partners.shopify.com/)
2. Click "Join now" and complete registration
3. Verify your email

## Step 2: Create Development Store

1. In Partner Dashboard, go to "Stores"
2. Click "Add store" → "Create development store"
3. Choose "Create a store to test and build"
4. Configure store:
   - Store name: `yepai-test-store`
   - Select your country
5. Click "Create development store"

## Step 3: Store Configuration

After creation:

1. Set up basic store settings:
   - Add a product (for testing)
   - Configure shipping zones
   - Set up payment provider (test mode)

2. Note your store URL:
   - Format: `your-store-name.myshopify.com`
   - This is your `SHOPIFY_STORE_URL`

## Step 4: Create Staff Account (Optional)

For separate test credentials:

1. Go to Settings → Users and permissions
2. Add staff → Enter test email
3. Set appropriate permissions
4. Use these credentials for automation

## Step 5: Configure Environment Variables

```env
SHOPIFY_STORE_URL=yepai-test-store.myshopify.com
SHOPIFY_EMAIL=your-partner@email.com
SHOPIFY_PASSWORD=your-password
SHOPIFY_SELECTED_PLAN=basic
```

## OAuth Flow Understanding

When testing the YepAI Shopify app installation:

```
1. YepAI clicks "Install on Shopify"
   ↓
2. Redirect to Shopify App Store or OAuth URL
   ↓
3. User enters store URL (if not embedded)
   ↓
4. Shopify login page
   - Enter email
   - Enter password
   - Handle 2FA if enabled
   ↓
5. OAuth permission screen
   - Review requested permissions
   - Click "Install app"
   ↓
6. Redirect back to YepAI callback
   ↓
7. Plan selection (if required)
   ↓
8. Installation complete
```

## Handling 2FA

If your account has 2FA enabled:

### Option A: Disable for Test Account
- Use a separate test account without 2FA
- Recommended for automation

### Option B: Manual Intervention
- Flow will pause at 2FA prompt
- Manually enter code when needed
- Less reliable for automation

### Option C: Authenticator App API
- Some TOTP apps have APIs
- Can programmatically generate codes
- Complex setup

## App Installation Methods

### Method 1: Direct OAuth URL
```
https://your-store.myshopify.com/admin/oauth/authorize?
  client_id=YOUR_CLIENT_ID&
  scope=read_products,write_products&
  redirect_uri=https://your-app.com/callback
```

### Method 2: App Store
- Navigate to Shopify App Store
- Search for YepAI
- Click Install

### Method 3: Partner Dashboard
- In Partners → Apps → Your App
- Test in development store

## Test Scenarios

### Happy Path
1. New user installs app
2. Authorizes all permissions
3. Selects a plan
4. Starts using the app

### Edge Cases
- User cancels authorization
- User already has app installed
- Store has restrictions
- Billing fails

## Cleaning Up Between Tests

To reset installation state:

1. Go to development store admin
2. Apps → YepAI → Uninstall
3. Confirm uninstallation
4. Ready for fresh test

## Billing Test Mode

Development stores support test billing:

1. In YepAI Shopify app settings, enable test mode
2. Use test credit card: `4242 4242 4242 4242`
3. Any future date and CVV

## Troubleshooting

### "This app isn't available"
- App may not be approved for App Store
- Use direct OAuth URL instead

### "Invalid OAuth redirect"
- Check callback URL in app settings
- Verify it matches YepAI configuration

### "Access denied"
- Check requested scopes
- Ensure store has required features enabled

### Login fails repeatedly
- Clear browser cookies/cache
- Check for CAPTCHA
- Verify credentials are correct

---

## Quick Reference

| Variable | Example |
|----------|---------|
| `SHOPIFY_STORE_URL` | `yepai-test.myshopify.com` |
| `SHOPIFY_EMAIL` | `partner@email.com` |
| `SHOPIFY_PASSWORD` | `your-secure-password` |
| `SHOPIFY_SELECTED_PLAN` | `basic`, `professional`, `enterprise` |
