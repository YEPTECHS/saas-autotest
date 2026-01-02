---
name: yepai-register
description: Automate YepAI user registration with email verification. Triggers on "register new user", "test registration", "create test account", "sign up test user".
version: 1.0.0
---

# YepAI Registration Automation

This skill automates the complete YepAI user registration flow including email verification via Gmail API.

## Capabilities

- Navigate to YepAI registration page
- Fill registration form with test credentials
- Submit and wait for verification email
- Extract 6-digit verification code from Gmail
- Complete email verification
- Verify successful registration

## Prerequisites

Before using this skill, ensure:

1. **Gmail API configured** - OAuth credentials set up in Google Cloud Console
2. **Environment variables set** in `.env`:
   ```
   YEPAI_BASE_URL=https://app.yepai.io
   YEPAI_TEST_EMAIL=your-test@gmail.com
   YEPAI_TEST_PASSWORD=SecurePassword123!
   YEPAI_TEST_FIRST_NAME=Test
   YEPAI_TEST_LAST_NAME=User
   YEPAI_TEST_ORGANIZATION=Test Org
   GMAIL_CLIENT_ID=xxx
   GMAIL_CLIENT_SECRET=xxx
   GMAIL_REFRESH_TOKEN=xxx
   ```

## Usage

### Via CLI
```bash
cd /Users/i7ove/Documents/YepAI/yepai-e2e-automation
pnpm run flow registration
```

### Via Claude MCP Browser Tools

If you have `claude-in-chrome` MCP tools available, execute step-by-step:

1. Navigate to registration page
2. Fill form fields
3. Click submit
4. Use Gmail API to get verification code
5. Enter code and verify

### Via AI Tool Call

```json
{
  "tool": "run_e2e_flow",
  "arguments": {
    "flowName": "registration",
    "variables": {
      "testEmail": "custom@gmail.com"
    }
  }
}
```

## Flow Steps

1. `navigate-register` - Go to /auth/register
2. `fill-registration-form` - Enter user details
3. `submit-registration` - Click submit button
4. `wait-for-verification-email` - Poll Gmail for verification email
5. `extract-verification-code` - Extract 6-digit code
6. `enter-verification-code` - Input code in verification form
7. `submit-verification` - Complete verification
8. `assert-logged-in` - Verify redirect to dashboard

## Troubleshooting

### Email not received
- Check Gmail API credentials are valid
- Verify target email matches GMAIL_TARGET_EMAIL
- Increase timeout (default: 90 seconds)

### Verification code not found
- Check email subject filter matches
- Verify code pattern (default: 6 digits)

### Form submission fails
- Check YepAI application is running
- Verify BASE_URL is correct
- Check for UI changes in registration form
