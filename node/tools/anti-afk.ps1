# Temporary testing aid: taps a movement key in the local WarRock client
# every 45s so it doesn't hit the client's own AFK-kick (Fase 25: ~115s of
# zero input triggers an automatic ROOM_LEAVE) while attention is on the VM
# client instead. Briefly focuses the WarRock window, sends the key, then
# restores whatever window was focused before - not meant to run unattended
# forever, just while testing.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AntiAfkWin32 {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@
Add-Type -AssemblyName System.Windows.Forms

Write-Output "anti-afk: tapping W in WarRock every 45s. Ctrl+C to stop."

while ($true) {
    $prev = [AntiAfkWin32]::GetForegroundWindow()
    $proc = Get-Process -Name "WarRock" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
        [AntiAfkWin32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
        Start-Sleep -Milliseconds 200
        [System.Windows.Forms.SendKeys]::SendWait("w")
        Start-Sleep -Milliseconds 100
        [AntiAfkWin32]::SetForegroundWindow($prev) | Out-Null
        Write-Output "$(Get-Date -Format 'HH:mm:ss') - tapped W"
    } else {
        Write-Output "$(Get-Date -Format 'HH:mm:ss') - WarRock window not found"
    }
    Start-Sleep -Seconds 45
}
