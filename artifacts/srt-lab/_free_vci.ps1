# Free the TOPDON VCI so a J2534 client (our bridge) can claim PassThruOpen.
# TOPDON's RLink / VCI software holds the adapter; until it's stopped, PassThruOpen
# fails with ERR_DEVICE_IN_USE. Reversible: Start-Service or a reboot brings them
# back. Run as Administrator to also stop the services (process kill works without
# admin). Ported from sincro/_free_vci.ps1.
$log = Join-Path $PSScriptRoot "_free_vci.log"
"=== free_vci run ===" | Out-File -FilePath $log -Encoding utf8

$svcNames = @('VCI Observer Services','VCIservice')
foreach ($s in $svcNames) {
    try {
        Stop-Service -Name $s -Force -ErrorAction Stop
        "Stopped service: $s" | Out-File -FilePath $log -Append -Encoding utf8
    } catch {
        "Could not stop service '$s' (need admin?): $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
    }
}

foreach ($pname in @('Rlink Platform','VciObserver','DiagsCap')) {
    $procs = Get-Process -Name $pname -ErrorAction SilentlyContinue
    if ($procs) {
        try { $procs | Stop-Process -Force -ErrorAction Stop; "Killed process: $pname" | Out-File -FilePath $log -Append -Encoding utf8 }
        catch { "Could not kill '$pname': $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8 }
    }
}

Start-Sleep -Seconds 2
"--- post-state ---" | Out-File -FilePath $log -Append -Encoding utf8
Get-Service -Name $svcNames -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name): $($_.Status)" | Out-File -FilePath $log -Append -Encoding utf8 }
$still = Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'vciobserver|diagscap|rlink' } | ForEach-Object { $_.Name }
if ($still) { "Still running: $($still -join ', ')" | Out-File -FilePath $log -Append -Encoding utf8 } else { "All TOPDON procs closed." | Out-File -FilePath $log -Append -Encoding utf8 }
