# AI Debugger — Repo Guide

## Project Structure

```
qa-bugs/          — Python QA test modules with known bugs
qa-bugs/tests/    — pytest test suite for qa-bugs
src/              — Main TypeScript automation (do not modify)
scripts/          — TypeScript scripts (do not modify)
```

## Language & Runtime

- Python 3.11+ (qa-bugs/ directory only)
- TypeScript (src/ and scripts/ — do not touch)

## Running Tests

```bash
pip install pytest
pytest qa-bugs/tests/ -v
```

## Branch Convention

`ai-fix/{issue_id}-{slug}`

## Test File Convention

Tests live in `qa-bugs/tests/` and are named `test_{module}.py`.

## Blocked Paths

Do not modify:
- `src/`
- `scripts/`
- `skills/`
- `.github/`
- `package.json`
- `pnpm-lock.yaml`

## Notes

- Only work within the `qa-bugs/` directory
- Bugs are logic errors in existing functions in `qa-bugs/`
- Always run `pytest qa-bugs/tests/ -v` to validate your fix
