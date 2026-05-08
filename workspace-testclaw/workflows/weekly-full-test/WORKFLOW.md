---
name: weekly-full-test
description: Full weekly test run — stress, tab isolation, accuracy, boundary for all agents, then HTML report via email.
triggers:
  - "跑测试"
  - "run tests"
  - "full test"
  - "weekly test"
  - cron: every Saturday 09:00 MYT
---

# Workflow: Weekly Full Test

## Steps

### Step 1 — Stress Test
Run `skills/stress-test` for all agents.
- On failure: log errors, continue to Step 2 (don't abort)

### Step 2 — Tab Isolation
Run `skills/stress-test` tab isolation portion for all agents.
- On failure: log errors, continue to Step 3

### Step 3 — Accuracy Test
Run `skills/accuracy-test` for all agents.
- On `504` responses: mark as skipped, do not count as failure
- On session capture failure: retry once, then mark agent as "unreachable"

### Step 4 — Boundary (UI) Test
Run `skills/ui-test` for all agents.
- On failure: log errors, continue to Step 5

### Step 5 — Send Report
Run `skills/send-report`.
- Only runs if at least one of Steps 1–4 produced output
- Always runs even if some tests failed — partial results are still useful

### Step 6 — Update State
Write to `state/last-run.json`:
```json
{
  "last_run_at": "2026-05-08T09:00:00+08:00",
  "trigger": "cron",
  "status": "success",
  "summary": {
    "maya":   { "passed": 136, "total": 208, "rate": 65.4 },
    "oscar":  { "passed": 132, "total": 203, "rate": 65.0 },
    "daniel": { "passed": 180, "total": 203, "rate": 88.7 }
  },
  "report_sent_to": "kiechee.pau@yepai.io"
}
```

## Success Criteria

All of the following must be true:
- At least one agent's accuracy test completed
- HTML report generated
- Email sent successfully
