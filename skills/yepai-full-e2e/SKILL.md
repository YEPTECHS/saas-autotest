---
name: yepai-full-e2e
description: Complete YepAI onboarding E2E test - registration, email verification, and Shopify installation. Triggers on "full e2e test", "complete onboarding test", "test full flow", "run e2e automation".
version: 1.0.0
---

# YepAI Full E2E Onboarding Test

This skill runs the complete YepAI user journey from registration through Shopify app installation.

## Complete Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    PHASE 1: Registration                     │
├─────────────────────────────────────────────────────────────┤
│  1. Navigate to /auth/register                              │
│  2. Fill registration form                                   │
│  3. Submit and wait for verification page                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                 PHASE 2: Email Verification                  │
├─────────────────────────────────────────────────────────────┤
│  4. Wait for verification email (Gmail API)                  │
│  5. Extract 6-digit code                                     │
│  6. Enter code and verify                                    │
│  7. Confirm redirect to dashboard                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                PHASE 3: Shopify Installation                 │
├─────────────────────────────────────────────────────────────┤
│  8. Navigate to integration page                             │
│  9. Initiate Shopify OAuth                                   │
│ 10. Login to Shopify                                         │
│ 11. Authorize app                                            │
│ 12. Select plan                                              │
│ 13. Verify installation success                              │
└─────────────────────────────────────────────────────────────┘
```

## Prerequisites

All environment variables from both `yepai-register` and `yepai-shopify-install`:

```env
# YepAI
YEPAI_BASE_URL=https://app.yepai.io
YEPAI_TEST_EMAIL=test@gmail.com
YEPAI_TEST_PASSWORD=SecurePassword123!
YEPAI_TEST_FIRST_NAME=Test
YEPAI_TEST_LAST_NAME=User
YEPAI_TEST_ORGANIZATION=Test Org

# Gmail API
GMAIL_CLIENT_ID=xxx
GMAIL_CLIENT_SECRET=xxx
GMAIL_REFRESH_TOKEN=xxx

# Shopify
SHOPIFY_STORE_URL=dev-store.myshopify.com
SHOPIFY_EMAIL=partner@example.com
SHOPIFY_PASSWORD=xxx
SHOPIFY_SELECTED_PLAN=basic
```

## Usage

### Via CLI
```bash
cd /Users/i7ove/Documents/YepAI/yepai-e2e-automation
pnpm run flow full-onboarding
```

### Via AI Tool Call
```json
{
  "tool": "run_e2e_flow",
  "arguments": {
    "flowName": "full-onboarding",
    "headless": false,
    "slowMo": 100
  }
}
```

### With Custom Variables
```json
{
  "tool": "run_e2e_flow",
  "arguments": {
    "flowName": "full-onboarding",
    "variables": {
      "testEmail": "newuser@gmail.com",
      "shopifyStore": "custom-store.myshopify.com"
    }
  }
}
```

## Expected Duration

| Phase | Estimated Time |
|-------|---------------|
| Registration | 10-15 seconds |
| Email Wait | 30-90 seconds |
| Verification | 5-10 seconds |
| Shopify OAuth | 30-60 seconds |
| **Total** | **75-175 seconds** |

## Output Artifacts

After successful execution:

- `screenshots/phase1_registration_submitted.png`
- `screenshots/phase2_email_verified.png`
- `screenshots/phase3_onboarding_complete.png`

## Error Handling

The flow uses `continueOnError: true` for non-critical steps. Critical failures will stop execution:

- Registration form submission failure
- Email verification timeout
- OAuth authorization failure

## Running Independently

You can also run individual phases:

```bash
# Only registration
pnpm run flow registration

# Only Shopify (requires logged-in user)
pnpm run flow shopify-install
```

## Integration with CI/CD

For future CI integration:

```yaml
# .github/workflows/e2e.yml
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm run flow full-onboarding
        env:
          YEPAI_BASE_URL: ${{ secrets.YEPAI_BASE_URL }}
          GMAIL_CLIENT_ID: ${{ secrets.GMAIL_CLIENT_ID }}
          # ... other secrets
```
