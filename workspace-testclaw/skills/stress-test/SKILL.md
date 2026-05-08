---
name: stress-test
description: Run API stress tests and tab isolation tests for Maya, Oscar, and Daniel. Measures response reliability, latency, and multi-tab isolation.
---

# Skill: stress-test

**Output:** `reports/{agent}-api-stress-results.json`, `reports/{agent}-tab-isolation-results.json`

## Steps

### Step 1 — API Stress

```bash
pnpm stress:api:maya
pnpm stress:api:oscar
pnpm stress:api:daniel
```

Each generates `reports/{agent}-api-stress-results.json` with:
- `results[].status` — PASS / FAIL
- `results[].successRate` — % of requests that succeeded
- `results[].latency.p95` — 95th percentile latency (ms)
- `results[].throughputRps` — requests per second

### Step 2 — Tab Isolation

```bash
pnpm test:tab:maya
pnpm test:tab:oscar
pnpm test:tab:daniel
```

Each generates `reports/{agent}-tab-isolation-results.json`.
Tests that different browser tabs maintain separate sessions.

### Step 3 — Return summary

Format:
```
🔥 API Stress
   Maya:   6/6 PASS  | p95: 8s  | RPS: 0.4
   Oscar:  6/6 PASS  | p95: 5s  | RPS: 0.6
   Daniel: 6/6 PASS  | p95: 12s | RPS: 0.3

🔒 Tab Isolation
   Maya:   5/6 (1 fail: cross-tab context leak)
   Oscar:  6/6 PASS
   Daniel: 5/6 PASS
```
