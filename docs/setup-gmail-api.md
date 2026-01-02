# Gmail API Setup Guide

This guide walks you through setting up Gmail API access for automated email verification code retrieval.

## Overview

The automation framework uses Gmail API with OAuth 2.0 to:
- Monitor incoming emails for verification codes
- Extract 6-digit codes from email content
- Support polling with configurable timeout

## Step 1: Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Name it (e.g., "YepAI E2E Automation")
4. Click "Create"

## Step 2: Enable Gmail API

1. In your project, go to "APIs & Services" → "Library"
2. Search for "Gmail API"
3. Click on it and press "Enable"

## Step 3: Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Select "External" user type (or Internal if using Google Workspace)
3. Fill in required fields:
   - App name: "YepAI E2E Automation"
   - User support email: Your email
   - Developer contact: Your email
4. Click "Save and Continue"
5. Add scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.modify` (optional, for marking emails as read)
6. Add your Gmail as a test user
7. Complete the wizard

## Step 4: Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. Application type: "Desktop app"
4. Name: "YepAI E2E CLI"
5. Click "Create"
6. Download the JSON file (keep it secure!)

## Step 5: Get Refresh Token

You need a refresh token for automated access. Use this script:

```javascript
// get-refresh-token.js
const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const open = require('open');

const CLIENT_ID = 'your-client-id';
const CLIENT_SECRET = 'your-client-secret';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // Force refresh token
});

console.log('Opening browser for authorization...');
open(authUrl);

const server = http.createServer(async (req, res) => {
  const query = url.parse(req.url, true).query;

  if (query.code) {
    const { tokens } = await oauth2Client.getToken(query.code);

    console.log('\n=== OAuth Tokens ===');
    console.log('Refresh Token:', tokens.refresh_token);
    console.log('Access Token:', tokens.access_token);
    console.log('\nAdd this to your .env file:');
    console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);

    res.end('Authorization successful! You can close this window.');
    server.close();
  }
}).listen(3000);

console.log('Waiting for authorization...');
```

Run it:
```bash
npm install googleapis open
node get-refresh-token.js
```

## Step 6: Configure Environment Variables

Add to your `.env` file:

```env
GMAIL_CLIENT_ID=your-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
GMAIL_TARGET_EMAIL=test@gmail.com
```

## Step 7: Test the Setup

```bash
cd /Users/i7ove/Documents/YepAI/yepai-e2e-automation
pnpm install
pnpm run tool get_gmail_verification_code --args '{"email":"your@gmail.com","subject":"test"}'
```

## Security Best Practices

1. **Never commit credentials** - Add `.env` to `.gitignore`
2. **Use test accounts** - Don't use production email for testing
3. **Limit scope** - Only request `gmail.readonly` if possible
4. **Rotate tokens** - Periodically regenerate refresh tokens
5. **Restrict access** - Keep test users list minimal

## Troubleshooting

### "invalid_grant" Error
- Refresh token may be expired
- Regenerate using the authorization flow

### "Access Not Configured"
- Ensure Gmail API is enabled in your project

### "User not in test users list"
- Add your Gmail to OAuth consent screen test users

### Rate Limits
- Gmail API has quota limits
- Default: 250 quota units per user per second
- Use polling intervals of 3+ seconds

## Alternative: App Password + IMAP

If OAuth is too complex, you can use Gmail App Password:

1. Enable 2-Step Verification on your Google Account
2. Go to Security → App passwords
3. Generate a new app password for "Mail"
4. Use with IMAP library (less secure, not recommended)

---

## Quick Reference

| Variable | Description |
|----------|-------------|
| `GMAIL_CLIENT_ID` | OAuth client ID from Google Cloud Console |
| `GMAIL_CLIENT_SECRET` | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Long-lived refresh token for API access |
| `GMAIL_TARGET_EMAIL` | Email address to monitor for verification codes |
