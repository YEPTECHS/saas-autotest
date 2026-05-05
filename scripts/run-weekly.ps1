$projectDir = "c:\Users\pauki\Downloads\saase2etest\saase2etest"
$logFile = "$projectDir\reports\weekly-run-$(Get-Date -Format 'yyyy-MM-dd').log"

Set-Location $projectDir

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

Log "=== YepAI Weekly Full Test Run ==="

# ── 1. API Stress ──────────────────────────────────────────
Log "--- API Stress: Maya ---"
pnpm stress:api:maya 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- API Stress: Oscar ---"
pnpm stress:api:oscar 2>&1 | Tee-Object -FilePath $logFile -Append

Log "--- API Stress: Daniel ---"
pnpm stress:api:daniel 2>&1 | Tee-Object -FilePath $logFile -Append

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

# ── 5. HTML Report + Email ─────────────────────────────────
Log "--- Generating HTML Report and Sending Email ---"
pnpm report:html:email 2>&1 | Tee-Object -FilePath $logFile -Append

Log "=== Done. Log saved to $logFile ==="
