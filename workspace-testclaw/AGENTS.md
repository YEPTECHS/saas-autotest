# AGENTS.md — How to Use TestClaw

## Every Session

Before running any test:
1. Read `IDENTITY.md` — what agents and tests are in scope
2. Read `TOOLS.md` — endpoint, credentials, pnpm commands
3. Check `state/last-run.json` — avoid re-running what already passed today

## Trigger Keywords

| User says | Action |
|-----------|--------|
| "跑测试" / "run tests" / "full test" | Trigger `workflows/weekly-full-test` |
| "quick check" / "smoke test" / "快速检查" | Trigger `workflows/quick-smoke` |
| "accuracy only" / "只跑 accuracy" | Run `skills/accuracy-test` directly |
| "stress test" | Run `skills/stress-test` directly |
| "发报告" / "send report" | Run `skills/send-report` directly |

## Skills vs Workflows

- **Skills** = single action. Run one thing, return one result.
- **Workflows** = chain of skills. Run multiple things in order, handle failures between steps.

Always prefer a workflow when running more than one skill together.

## Failure Handling

- `504 / 502 / 503` → skip the test case, mark as "server timeout", do NOT count as failure
- Session capture fails → try next user in `data/test-users.json`, max 3 users
- All users fail → abort the skill, report "platform unreachable"
- Individual test fails → continue remaining tests, include in final failure list

## State Updates

After every skill run, update `state/last-run.json` with:
- timestamp
- which skill ran
- pass/fail counts per agent
- any errors

## Safety

- All tests are read-only. Never write to the YepAI platform.
- Credentials stay in `.env` — never log or expose them.
