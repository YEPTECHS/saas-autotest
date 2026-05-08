---
name: send-report
description: Generate an HTML dashboard from all test reports and email it to the team.
---

# Skill: send-report

**Output:** `reports/agent-test-report-YYYY-MM-DD.html` + email to `REPORT_EMAIL_TO`

## Steps

### Step 1 — Generate and send

```bash
pnpm report:html:email
```

This reads all JSON reports in `reports/` and:
1. Groups by agent (maya, oscar, daniel)
2. Renders 4 sections per agent: API Stress, Tab Isolation, Accuracy, Boundary
3. Saves HTML to `reports/agent-test-report-YYYY-MM-DD.html`
4. Sends email via Gmail SMTP

### Step 2 — Verify

Check output:
- `[Email] ✅ Report sent to {email}` → success
- Any SMTP error → report the error, do not retry more than once

### Step 3 — Return summary

```
📧 Report sent → kiechee.pau@yepai.io
📄 HTML saved → reports/agent-test-report-2026-05-08.html

Overall:
  ✅ DANIEL: 89%
  ⚠️ MAYA:   65%
  ⚠️ OSCAR:  65%
```

## Email Config

Reads from `.env`:
- `REPORT_EMAIL_FROM` — sender Gmail address
- `REPORT_EMAIL_PASS` — Gmail App Password
- `REPORT_EMAIL_TO` — recipient
