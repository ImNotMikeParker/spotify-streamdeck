# Force-restarts the plugin. Stream Deck 7.0.x ignores the CLI's `streamdeck restart` deep link for
# side-loaded plugins, so we end the plugin's own Node process and let Stream Deck relaunch it.
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node20.exe' OR Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match "com\.mjp\.spotifydeck\.sdPlugin" }
if (-not $procs) { Write-Host "Plugin process not found (is Stream Deck running and the plugin linked?)"; exit 1 }
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force; Write-Host "Stopped plugin process $($p.ProcessId)" }
Start-Sleep -Seconds 3
$again = Get-CimInstance Win32_Process -Filter "Name = 'node20.exe' OR Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match "com\.mjp\.spotifydeck\.sdPlugin" }
if ($again) { Write-Host "Stream Deck relaunched the plugin (pid $($again.ProcessId))" } else { Write-Host "Plugin did not come back yet; Stream Deck usually relaunches it within a few seconds." }
