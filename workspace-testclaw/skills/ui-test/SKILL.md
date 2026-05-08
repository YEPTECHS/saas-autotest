---
name: ui-test
description: Run Playwright YAML flow tests covering boundary tests for all three agents (Maya/Oscar/Daniel UI interactions).
---

# Skill: ui-test

**Output:** `reports/mktbnd-*.json`, `reports/opbnd-*.json`, `reports/daniel-bnd-*.json`

## Parameters

| Param | Values | Default |
|-------|--------|---------|
| `--agent` | `maya`, `oscar`, `daniel`, `all` | `all` |

## Steps

### Step 1 — Run boundary flows

```bash
# All agents
pnpm flow test-marketing-boundary
pnpm flow test-operation-boundary
pnpm flow test-daniel-boundary
```

### Step 2 — Check output files

Each flow generates multiple `bnd-*.json` files under `reports/`.
Each file is an array of `{ id, q, a, status, passed }` objects.

### Step 3 — Return summary

Count PASS/FAIL across all `bnd-` files per agent prefix:
- `mktbnd-*` → Maya boundary
- `opbnd-*` → Oscar boundary
- `daniel-bnd-*` → Daniel boundary

Format:
```
🧪 Maya Boundary:   116/180 (64%)
🧪 Oscar Boundary:  110/180 (61%)
🧪 Daniel Boundary: 159/180 (88%)
```

## Flow Files

| Flow | Tests |
|------|-------|
| `test-marketing-boundary.flow.yml` | Maya: content safety, topic scope, hallucination |
| `test-operation-boundary.flow.yml` | Oscar: read-only, privacy, scope |
| `test-daniel-boundary.flow.yml` | Daniel: calculation accuracy, fraud refusal |
