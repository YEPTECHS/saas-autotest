# TOOLS.md — Configuration & Commands

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

## pnpm Commands

```bash
# Accuracy tests
pnpm accuracy                    # all agents
pnpm accuracy:maya
pnpm accuracy:oscar
pnpm accuracy:daniel

# API Stress
pnpm stress:api:maya
pnpm stress:api:oscar
pnpm stress:api:daniel

# Tab Isolation
pnpm test:tab:maya
pnpm test:tab:oscar
pnpm test:tab:daniel

# Boundary flows (YAML)
pnpm flow test-marketing-boundary
pnpm flow test-operation-boundary
pnpm flow test-daniel-boundary

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
