---
name: quick-smoke
description: Fast smoke check — accuracy tests only (no stress/UI). Use this to quickly verify all three agents are responding correctly.
triggers:
  - "quick check"
  - "smoke test"
  - "快速检查"
  - "只跑 accuracy"
---

# Workflow: Quick Smoke Check

**Duration:** ~15 minutes (vs ~2 hours for full test)

## Steps

### Step 1 — Accuracy Test (all agents)
Run `skills/accuracy-test --agent all`.

### Step 2 — Return Results
```
🧪 Smoke Check Results
   Maya:   16/16 (100%) ✅
   Oscar:  11/11 (100%) ✅
   Daniel: 10/11 (90.9%) ⚠️ → DANIEL-CI-02 failed
```

### Step 3 — Update State
Append to `state/last-run.json` with `"trigger": "smoke"`.

## When to Use

- After a platform deployment — verify agents still work
- Before a demo — quick sanity check
- When you don't have time for the full test
