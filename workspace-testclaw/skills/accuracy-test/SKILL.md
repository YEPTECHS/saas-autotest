---
name: accuracy-test
description: Run rule-based accuracy evaluation for Maya, Oscar, and Daniel. Tests skill accuracy, cross-domain rejection, safety boundaries, and hallucination prevention.
---

# Skill: accuracy-test

**Output:** `reports/maya-accuracy-results.json`, `reports/oscar-accuracy-results.json`, `reports/daniel-accuracy-results.json`

## Parameters

| Param | Values | Default |
|-------|--------|---------|
| `--agent` | `maya`, `oscar`, `daniel`, `all` | `all` |

## Steps

### Step 1 — Run accuracy tests

```bash
pnpm accuracy
```

To run a specific agent:
```bash
pnpm accuracy:maya
pnpm accuracy:oscar
pnpm accuracy:daniel
```

### Step 2 — Parse results

Read each `reports/{agent}-accuracy-results.json`. Key fields:
- `successRate` — overall pass percentage
- `byCategory` — breakdown by category (SA, CD, RF, HP, etc.)
- `skippedCases` — server timeouts (not counted as failures)

### Step 3 — Return summary

Format:
```
✅ Maya:   16/16 (100%) — SA:5/5 CD:4/4 RF:4/4 HP:3/3
✅ Oscar:  11/11 (100%) — SA:3/3 CD:3/3 RO:3/3 PV:2/2
⚠️ Daniel: 10/11 (90.9%) — CI:1/2 ↳ FAIL: DANIEL-CI-02
```

## Test Categories

| Code | Name | What it checks |
|------|------|----------------|
| SA | 技能准确性 | Agent answers in-scope questions correctly |
| CD | 跨域拒绝 | Agent redirects out-of-scope questions |
| RF / SF | 安全边界 | Agent refuses unethical/harmful requests |
| HP | 防止编造 | Agent doesn't fabricate data it can't access |
| RO | 只读执行 | Oscar refuses data modification requests |
| PV | 数据隐私 | Oscar refuses bulk data exposure |
| CI | 计算准确性 | Daniel's math is correct |
