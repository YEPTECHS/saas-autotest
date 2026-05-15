# Tab Isolation & Sync Test Report

**Date:** 2026-04-16
**Tested by:** kc@vivacityapp.com
**Test suite:** `test-tab-sync.ts`, `test-tab-isolation.ts`
**Agents under test:** Maya, Oscar, Daniel
**Test environment:** Same user, same browser session (shared cookies), two browser tabs open on the same AI agent chat page

---

## Executive Summary

Two test types were executed to evaluate tab behavior for three AI agents: Maya (`/ai-team/marketing/chat`), Oscar, and Daniel (`/ai-team/profit/chat`). The tests asked two distinct questions:

1. **Tab Sync:** Does Tab A's activity automatically appear in Tab B without any action from the user?
2. **Tab Isolation:** Does confidential context established in Tab A leak into Tab B when Tab B independently queries the agent?

Two confirmed bugs were identified:

| # | Bug | Severity | Agents Affected |
|---|-----|----------|-----------------|
| 1 | Shared live conversation stream across tabs | **HIGH** | Maya (confirmed; likely all agents) |
| 2 | Concurrent response mixing when both tabs send messages simultaneously | **CRITICAL** | Oscar, Daniel |

Context isolation for sequential (non-concurrent) interactions was generally strong across all three agents — confidential data shared in Tab A did not leak to Tab B when queried independently.

---

## Bug Findings

### Bug 1 — Shared Live Conversation Stream

**Severity:** HIGH

**Description:**
When the same user opens two tabs on the same agent chat page within the same browser session, both tabs connect to the same live conversation stream. Any message sent from Tab A — and the AI's response to it — automatically appears in Tab B without Tab B taking any action. The reverse is also true: Tab B messages appear in Tab A.

**Evidence (Maya, user: fasigit832@okexbit.com):**

| Round | Tab A sent | Tab B received (automatically) |
|-------|-----------|-------------------------------|
| 1 | "Write a short tagline for a summer sale campaign." | 2 new message bubbles (user + AI) |
| 2 | "My brand is called SunBloom. What marketing channels should I use?" | 2 new message bubbles |
| 3 | "Create 3 subject lines for a flash sale email." | 1 new message bubble |
| Bonus (reverse) | Tab B sent "Suggest a headline for a product launch." | Tab A auto-received 2 new bubbles |

All 4 rounds returned a FAILED result — the tabs were not independent.

**Impact:**
Users who open the same chat page in two tabs naturally expect two independent sessions. Instead, they are looking at the same conversation from two windows. Any message typed in either tab is visible to anyone with access to the other tab (e.g., in a shared-screen or split-monitor scenario). This also means a user attempting to run parallel independent queries cannot do so.

**Root cause hypothesis:**
The frontend subscribes both tabs to the same conversation ID (derived from the session/cookie), and the real-time stream (likely WebSocket or SSE) pushes updates to all active subscribers for that conversation.

---

### Bug 2 — Concurrent Response Mixing

**Severity:** CRITICAL

**Description:**
When two tabs send different questions at nearly the same time to the same agent, the backend either mixes the responses between the tabs or returns identical responses to both. This is a race condition in concurrent request handling.

**Evidence — Oscar (TAB-03):**
- Tab A asked: "Show me top 5 selling products by revenue"
- Tab B asked: "How many total orders are pending fulfillment?"
- Result: Responses were mixed between the tabs — each tab received content intended for the other, or a blend of both answers.

**Evidence — Daniel (TAB-03):**
- Tab A asked: "What is the highest-priced SKU margin?"
- Tab B asked: "What is the lowest gross margin SKU?"
- Result: Both tabs received identical responses, suggesting cross-contamination of the reply routing.

**Impact:**
This is a data integrity failure. In a business context, a user could receive financial or operational data that was meant for a different query. For agents handling sensitive margin data (Daniel) or fulfillment operations (Oscar), receiving incorrect or swapped answers could lead to faulty business decisions. The issue is reproducible by design whenever two tabs interact with the same agent concurrently.

**Root cause hypothesis:**
The backend likely identifies in-flight requests by conversation ID or session token rather than a unique per-request identifier. When two requests arrive with the same conversation context simultaneously, the response routing collides.

---

## Per-Agent Results

### Maya — `/ai-team/marketing/chat`

#### Tab Sync Test

| Round | Message sent from Tab A | Tab B auto-updated? | Result |
|-------|------------------------|---------------------|--------|
| 1 | "Write a short tagline for a summer sale campaign." | Yes — 2 bubbles | FAIL |
| 2 | "My brand is called SunBloom. What marketing channels should I use?" | Yes — 2 bubbles | FAIL |
| 3 | "Create 3 subject lines for a flash sale email." | Yes — 1 bubble | FAIL |
| Bonus | Tab B sent "Suggest a headline for a product launch." | Tab A auto-received 2 bubbles | FAIL |

#### Tab Isolation Test

| Scenario | Description | Result | Notes |
|----------|-------------|--------|-------|
| TAB-01 | Campaign context isolation | PASS | Tab B received 0 chars; "Project SOLSTICE" did not leak |
| TAB-02 | Brand voice isolation | PASS | Tab B did not inherit Tab A's pirate speak setting |
| TAB-03 | Concurrent content generation | PASS | Each tab received its own correct response (candle vs. boots) |
| TAB-04 | Budget data isolation | PASS | Tab B did not see the $185,000 budget |
| TAB-05 | Conversation history isolation | ERROR | Textarea remained disabled — technical issue; likely caused by the shared stream locking the input |
| BONUS | New tab (Tab C) | WARN | Tab C received a 848-char response; no prior conversation context mentioned |

**Maya summary:** Isolation logic is sound for sequential queries. The Tab Sync bug (Bug 1) is confirmed here. TAB-05 produced a technical error (input lock) rather than a clean test outcome, requiring a re-run once Bug 1 is resolved.

---

### Oscar

#### Tab Isolation Test

| Scenario | Description | Result | Notes |
|----------|-------------|--------|-------|
| TAB-01 | Warehouse filter isolation | PASS | Tab B did not inherit Dallas warehouse filter from Tab A |
| TAB-02 | Urgent order isolation | PASS | Tab B had no knowledge of order #TABTEST-7777 |
| TAB-03 | Concurrent different queries | **FAIL (CRITICAL)** | Response mixing detected — tabs received each other's answers |
| TAB-04 | Conversation history isolation | PASS | Tab B confirmed "This is actually the start of our conversation!" |
| TAB-05 | Confidential note isolation | PASS | Tab B did not see MegaShip logistics contract data |
| BONUS | New tab (Tab C) | PASS | Tab C correctly started a fresh session with no history |

**Oscar summary:** Context isolation for sequential tests is clean (4/5 passing, 1 critical failure). Bug 2 (concurrent response mixing) is confirmed in TAB-03.

---

### Daniel — `/ai-team/profit/chat`

#### Tab Isolation Test

| Scenario | Description | Result | Notes |
|----------|-------------|--------|-------|
| TAB-01 | Pricing strategy isolation | PASS | Tab B had no knowledge of SKU-TABTEST-001 78% margin target |
| TAB-02 | COGS data isolation | PASS | Tab B did not see $8.77/unit COGS for Product-SECRET-X |
| TAB-03 | Concurrent margin queries | **FAIL (HIGH)** | Both tabs received identical responses — possible cross-contamination |
| TAB-04 | Conversation history isolation | PASS | Tab B confirmed no memory of Tab A's CodexBrand/pricing discussion |
| TAB-05 | Forecast assumption isolation | PASS | Tab B used default assumptions, not Tab A's custom 30%/20% figures |
| BONUS | New tab (Tab C) | PASS | Tab C started fresh with no inherited context |

**Daniel summary:** Context isolation is strong for sequential tests (4/5 passing, 1 high-severity failure). Bug 2 is confirmed in TAB-03, with both tabs receiving identical responses instead of independent answers.

---

## Severity Assessment

| Bug | ID | Severity | Reproducibility | Affected Agents |
|-----|----|----------|-----------------|-----------------|
| Shared live conversation stream | BUG-1 | HIGH | Confirmed — 4/4 rounds failed | Maya (confirmed); likely all agents sharing session-based conversation IDs |
| Concurrent response mixing / identical responses | BUG-2 | CRITICAL | Confirmed — 2/2 agents (Oscar, Daniel) failed TAB-03 | Oscar, Daniel; Maya TAB-03 passed (possible timing difference) |

**Severity rationale:**
- BUG-2 is rated CRITICAL because it produces incorrect data delivery — a user receives an answer to a question they did not ask, or the same answer for two different questions. In financial (Daniel) or operational (Oscar) contexts this directly risks decision-making errors.
- BUG-1 is rated HIGH because it violates user expectations of tab independence and could expose in-progress conversations to unintended viewers in shared environments.

---

## Recommended Fixes

### Fix for Bug 1 — Shared Live Conversation Stream

**Recommendation:** Assign a unique conversation ID per page load (tab), not per session or user.

- On tab open, generate a new `conversationId` (UUID) regardless of whether a prior conversation exists for the session.
- If users need to resume a previous conversation, provide an explicit "continue previous conversation" affordance rather than auto-resuming by default.
- The real-time stream (WebSocket/SSE) subscription should be scoped to `conversationId`, not to `sessionId` or `userId` alone.
- Consider adding a UI indicator when a conversation is shared across tabs, as a near-term mitigation if the architectural fix requires more time.

### Fix for Bug 2 — Concurrent Response Mixing

**Recommendation:** Tag every request with a unique, per-request identifier and use it to route responses.

- Generate a unique `requestId` (UUID) on the client for every message submission.
- Include the `requestId` in the API request payload and return it in the API response.
- On the client, match incoming streamed responses to the originating `requestId` before rendering. Discard or queue responses that do not match the tab's active `requestId`.
- On the backend, ensure the response queue or dispatcher routes by `requestId` rather than by `conversationId` or `sessionId` alone to prevent reply collision when concurrent requests share the same conversation context.
- Add integration test coverage for the concurrent-request scenario (two simultaneous messages from the same conversation) as a regression guard.

### Additional Recommendations

- **Re-run Maya TAB-05** after Bug 1 is resolved. The input lock (textarea disabled) is likely a side effect of the shared stream and may not reflect a genuine isolation failure.
- **Extend Tab Sync testing to Oscar and Daniel.** The sync test was only run on Maya. Given the shared architecture, Oscar and Daniel are expected to exhibit the same behavior. Confirming this will establish full scope of Bug 1.
- **Add concurrent-request tests to the CI suite** for all agents to catch response-mixing regressions automatically.

---

## Appendix — Test Configuration

| Item | Value |
|------|-------|
| Test files | `test-tab-sync.ts`, `test-tab-isolation.ts` |
| Maya URL | `/ai-team/marketing/chat` |
| Daniel URL | `/ai-team/profit/chat` |
| Test user (sync test) | fasigit832@okexbit.com |
| Browser setup | Same browser session, shared cookies, 2 tabs |
| Tab Sync test rounds | 4 (including 1 reverse/bonus) |
| Tab Isolation scenarios per agent | 5 + 1 BONUS |
| Total TAB-03 failures | 2 of 3 agents (Oscar: CRITICAL, Daniel: HIGH) |
