# Permanent fix: stop TOPDON from auto-grabbing the VCI on every boot.
#  - Sets 'VCI Observer Services' and 'VCIservice' to Manual start.
#  - Removes the 'Rlink Platform' login auto-launch (Run key), after backing it up.
# Writes a matching _restore_topdon_autostart.ps1 next to this file to undo it all.
# RUN ONCE, AS ADMINISTRATOR. Ported from sincro/_disable_topdon_autostart.ps1.
$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$log = Join-Path $dir "_topdon_autostart.log"
$restore = Join-Path $dir "_restore_topdon_autostart.ps1"
"=== disable_topdon_autostart run ===" | Out-File -FilePath $log -Encoding utf8

$restoreLines = New-Object System.Collections.Generic.List[string]
$restoreLines.Add('# Auto-generated. Run as Administrator to RESTORE TOPDON auto-start to its original state.')

# --- 1. Services -> Manual (record original StartMode for restore) ---
$svcNames = @('VCI Observer Services','VCIservice')
foreach ($name in $svcNames) {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$($name.Replace("'","''"))'" -ErrorAction SilentlyContinue
    if ($svc) {
        $orig = $svc.StartMode   # 'Auto','Manual','Disabled'
        $origType = if ($orig -eq 'Auto') { 'Automatic' } elseif ($orig -eq 'Manual') { 'Manual' } else { 'Disabled' }
        "Service '$name': original StartMode=$orig -> setting Manual" | Out-File -FilePath $log -Append -Encoding utf8
        try { Set-Service -Name $name -StartupType Manual -ErrorAction Stop } catch { "  ERROR: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8 }
        try { Stop-Service -Name $name -Force -ErrorAction SilentlyContinue } catch {}
        $restoreLines.Add("Set-Service -Name '$name' -StartupType $origType")
    } else {
        "Service '$name' not found" | Out-File -FilePath $log -Append -Encoding utf8
    }
}

# --- 2. Remove 'Rlink Platform' Run key (back up value first) ---
$runPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run'
)
$valName = 'Rlink Platform'
foreach ($rp in $runPaths) {
    if (Test-Path $rp) {
        $props = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue
        if ($props -and ($props.PSObject.Properties.Name -contains $valName)) {
            $val = $props.$valName
            "Run key in '$rp': '$valName' = $val -> removing (backed up)" | Out-File -FilePath $log -Append -Encoding utf8
            $restoreLines.Add("New-ItemProperty -Path '$rp' -Name '$valName' -Value '$val' -PropertyType String -Force | Out-Null")
            try { Remove-ItemProperty -Path $rp -Name $valName -Force -ErrorAction Stop } catch { "  ERROR removing: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8 }
        }
    }
}

# --- 3. Close any currently-running holders so the VCI is free right now ---
foreach ($pn in @('Rlink Platform','VciObserver','DiagsCap')) {
    Get-Process -Name $pn -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# --- write restore script ---
$restoreLines.Add('Write-Output "TOPDON auto-start restored. Reboot or start the services to use TOPDON software."')
$restoreLines | Out-File -FilePath $restore -Encoding utf8

"--- post-state ---" | Out-File -FilePath $log -Append -Encoding utf8
Get-Service -Name $svcNames -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name): $($_.Status) / $($_.StartType)" | Out-File -FilePath $log -Append -Encoding utf8 }
"Restore script written: $restore" | Out-File -FilePath $log -Append -Encoding utf8
"DONE" | Out-File -FilePath $log -Append -Encoding utf8
