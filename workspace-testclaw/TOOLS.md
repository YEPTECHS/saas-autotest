# TOOLS.md — Configuration & Commands

## Slack Setup

### A — Notifications (Incoming Webhook)
1. Go to https://api.slack.com/apps → Create App → From scratch
2. Activate **Incoming Webhooks** → Add New Webhook → pick a channel
3. Copy the webhook URL → add to `.env`: `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...`

Notifications are sent by:
- `pnpm triage --slack` / `pnpm triage:slack`
- `pnpm watch:agents:slack`
- `pnpm report:html:slack`
- CI workflow (automatic after adding `SLACK_WEBHOOK_URL` secret)

### B — Interactive Bot (Slash Commands)
1. In your Slack App → **Slash Commands** → Create New Command
   - Command: `/yepai`
   - Request URL: `https://your-public-host:3100/slack/command`
   - Short Description: `Run YepAI QA tests`
2. Go to **Basic Information** → copy **Signing Secret** → add to `.env`: `SLACK_SIGNING_SECRET=...`
3. Start the bot: `pnpm slack:bot`

> For local testing without a public URL, use [ngrok](https://ngrok.com):
> `ngrok http 3100` → copy the HTTPS URL as the Request URL

Supported slash commands:
```
/yepai help
/yepai accuracy [maya|oscar|daniel|cody|all]
/yepai triage [--days N]
/yepai watch [--run-tests]
/yepai status
```

---

## First-Run Setup

Run these once before using the automated pipeline:

```bash
# 1. Copy env template and fill in credentials
cp .env.example .env

# 2. Establish accuracy baseline for all agents
#    (change-watch-agent needs this to detect regressions)
pnpm watch:agents:baseline

# 3. Run a fingerprint check so change-watch has a starting point
pnpm watch:agents
```

After this, `pnpm watch:agents --run-tests` and the daily CI workflow will work correctly.

---

## YepAI Platform

- **Base URL:** `https://bot-test.yepai.io` (test env)
- **Login:** see `.env` → `YEPAI_LOGIN_EMAIL` / `YEPAI_LOGIN_PASSWORD`
- **Test users:** `data/test-users.json` (3 accounts)

## Agent Paths

| Agent | Path |
|-------|------|
| Maya | `/ai-team/marketing/chat` |
| Oscar | `/ai-team/operation/chat` |
| Daniel | `/ai-team/profit/chat` |
| Cody | `/ai-team/seo/chat` |

## pnpm Commands

```bash
# Accuracy tests
pnpm accuracy                    # all agents
pnpm accuracy:maya
pnpm accuracy:oscar
pnpm accuracy:daniel
pnpm accuracy:cody

# API Stress
pnpm stress:api:maya
pnpm stress:api:oscar
pnpm stress:api:daniel
pnpm stress:api:cody

# Tab Isolation
pnpm test:tab:maya
pnpm test:tab:oscar
pnpm test:tab:daniel
pnpm test:tab:cody

# Boundary flows (YAML)
pnpm flow test-marketing-boundary
pnpm flow test-operation-boundary
pnpm flow test-daniel-boundary
pnpm flow test-cody-boundary

# Comprehensive flows (YAML)
pnpm test:comprehensive:cody

# Triage — analyse recent test failures
pnpm triage                      # triage all recent reports
pnpm triage --days 3             # look back 3 days

# Change detection — fingerprint agents, auto-trigger tests on change
pnpm watch:agents                # one-shot check
pnpm watch:agents --run-tests    # check + run accuracy if changed

# Report
pnpm report:html:email           # generate HTML + send email
pnpm report:html                 # generate HTML only
```

## Reports

- **Output dir:** `reports/`
- **HTML report:** `reports/agent-test-report-YYYY-MM-DD.html`
- **Email recipient:** see `.env` → `REPORT_EMAIL_TO`

## Debug Mode

Set `DEBUG_ACCURACY=1` before running accuracy tests to see raw API responses:
```bash
DEBUG_ACCURACY=1 pnpm accuracy:maya
```
