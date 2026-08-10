$projectDir = "c:\Users\pauki\Downloads\saase2etest\saase2etest"
$logFile = "$projectDir\reports\weekly-run-$(Get-Date -Format 'yyyy-MM-dd').log"

Set-Location $projectDir

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

Log "=== YepAI Weekly Full Test Run ==="

# ── 1. WebSocket Stress (replaces old HTTP API stress — app uses WS now) ──
Log "--- WS Stress: Maya ---"
pnpm stress:ws:maya 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- WS Stress: Oscar ---"
pnpm stress:ws:oscar 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- WS Stress: Daniel ---"
pnpm stress:ws:daniel 2>&1 | Tee-Object -FilePath $logFile -Append

# ── 2. Tab Isolation ───────────────────────────────────────
Log "--- Tab Isolation: Maya ---"
pnpm test:tab:maya 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- Tab Isolation: Oscar ---"
pnpm test:tab:oscar 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- Tab Isolation: Daniel ---"
pnpm test:tab:daniel 2>&1 | Tee-Object -FilePath $logFile -Append

# ── 3. Accuracy ────────────────────────────────────────────
Log "--- Accuracy: All Agents ---"
pnpm accuracy 2>&1 | Tee-Object -FilePath $logFile -Append

# ── 4. Boundary Flows ──────────────────────────────────────
Log "--- Boundary: Maya (marketing) ---"
pnpm flow test-marketing-boundary 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- Boundary: Oscar (operation) ---"
pnpm flow test-operation-boundary 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- Boundary: Daniel ---"
pnpm flow test-daniel-boundary 2>&1 | Tee-Object -FilePath $logFile -Append

# ── 5. Digital Staff Chat Quality Tests ────────────────────
Log "--- DS Chat: All 4 flows + Slack ---"
pnpm ds:run:weekly 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- DS Email Report ---"
pnpm ds:email:report 2>&1 | Tee-Object -FilePath $logFile -Append

# ── 6. UI Interaction Flows ────────────────────────────────
Log "--- UI: Dashboard ---"
pnpm test:ui:dashboard 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- UI: Marketing buttons ---"
pnpm test:ui:marketing 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- UI: Operation buttons ---"
pnpm test:ui:operation 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- UI: Billing & Credits ---"
pnpm test:ui:billing 2>&1 | Tee-Object -FilePath $logFile -Append

# ── 7. HTML Report + Email ─────────────────────────────────
Log "--- Generating HTML Report and Sending Email ---"
pnpm report:html:email 2>&1 | Tee-Object -FilePath $logFile -Append

Log "=== Done. Log saved to $logFile ==="
