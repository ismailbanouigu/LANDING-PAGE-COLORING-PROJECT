$ErrorActionPreference = "Stop"

git rev-parse --is-inside-work-tree | Out-Null
git config core.hooksPath .githooks
Write-Output "Auto-push enabled (core.hooksPath=.githooks)."
