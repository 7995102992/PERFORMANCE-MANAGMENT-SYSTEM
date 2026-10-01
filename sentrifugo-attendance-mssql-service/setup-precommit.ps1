# Setup, configure, and run pre-commit

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }

Write-Step "Installing pre-commit"
pip install pre-commit

Write-Step "Installing git hooks"
pre-commit install

Write-Step "Running pre-commit on all files"
pre-commit run --all-files
