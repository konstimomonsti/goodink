# Measures launch → first visible top-level window of the started process (Win32, polled every 2 ms).
# usage: powershell -File tests/window-visible.ps1 -Exe <path> [-Runs 5] [-Electron]
param([Parameter(Mandatory = $true)][string]$Exe, [int]$Runs = 5, [switch]$Electron)
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class WinVis {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  static void KillTree(int pid) {
    var k = new ProcessStartInfo("taskkill", "/T /F /PID " + pid) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
    using (var x = Process.Start(k)) { x.WaitForExit(); }
  }
  public static long Measure(ProcessStartInfo psi) {
    var sw = Stopwatch.StartNew();
    var p = Process.Start(psi);
    uint target = (uint)p.Id;
    while (sw.ElapsedMilliseconds < 15000) {
      bool found = false;
      EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == target && IsWindowVisible(h)) { found = true; return false; } return true; }, IntPtr.Zero);
      if (found) { long t = sw.ElapsedMilliseconds; System.Threading.Thread.Sleep(2500); KillTree(p.Id); return t; }
      System.Threading.Thread.Sleep(2);
    }
    KillTree(p.Id);
    return -1;
  }
}
"@
$results = @()
for ($i = 0; $i -le $Runs; $i++) {
  $profile = Join-Path $env:TEMP ("gi-wv-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $lib = Join-Path $profile 'lib'
  New-Item -ItemType Directory -Force $lib | Out-Null
  $psi = New-Object System.Diagnostics.ProcessStartInfo $Exe
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables['GOODINK_TEST'] = '1'
  $psi.EnvironmentVariables['GOODINK_LIBRARY'] = $lib
  $psi.EnvironmentVariables['GOODINK_PROFILE'] = $profile
  if (-not $Electron) { $psi.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = (Join-Path $env:TEMP 'gi-wv-shared') }
  $t = [WinVis]::Measure($psi)
  if ($i -gt 0) { $results += $t }   # first run is a warm-up
}
$sorted = $results | Sort-Object
"runs: $($results -join ', ') -> median $($sorted[[int][math]::Floor($sorted.Count / 2)]) ms"
