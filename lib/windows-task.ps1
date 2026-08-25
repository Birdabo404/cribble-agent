param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('query', 'register', 'unregister', 'disable', 'enable', 'stop', 'start', 'export')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$TaskName
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

Import-Module ScheduledTasks -ErrorAction Stop

function Test-TaskMissing {
  param($ErrorRecord)
  $message = [string]$ErrorRecord.Exception.Message
  return $message -match 'No MSFT_ScheduledTask|cannot find|not found|does not exist'
}

function Get-CribbleTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
}

function Read-StdinText {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  try {
    return $reader.ReadToEnd()
  } finally {
    $reader.Dispose()
  }
}

try {
  switch ($Action) {
    'query' {
      $installed = $false
      $loaded = $false
      $disabled = $false
      try {
        $task = Get-CribbleTask
        $installed = $true
        $disabled = $task.State -eq 'Disabled'
        $loaded = -not $disabled
      } catch {
        if (-not (Test-TaskMissing $_)) { throw }
      }
      $payload = @{
        installed = $installed
        loaded = $loaded
        disabled = $disabled
      }
      [Console]::Out.Write(($payload | ConvertTo-Json -Compress))
      exit 0
    }
    'export' {
      try {
        [Console]::Out.Write((Export-ScheduledTask -TaskName $TaskName))
        exit 0
      } catch {
        if (Test-TaskMissing $_) { exit 44 }
        throw
      }
    }
    'register' {
      $xml = Read-StdinText
      if (-not $xml) {
        throw 'No Scheduled Task XML was received on stdin.'
      }
      Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
      exit 0
    }
    'unregister' {
      try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        exit 0
      } catch {
        if (Test-TaskMissing $_) { exit 44 }
        throw
      }
    }
    'disable' {
      Disable-ScheduledTask -TaskName $TaskName | Out-Null
      exit 0
    }
    'enable' {
      Enable-ScheduledTask -TaskName $TaskName | Out-Null
      exit 0
    }
    'stop' {
      try {
        Stop-ScheduledTask -TaskName $TaskName
        exit 0
      } catch {
        $message = [string]$_.Exception.Message
        if ($message -match 'not currently running|does not have a currently running|not yet run|cannot be stopped') {
          exit 0
        }
        throw
      }
    }
    'start' {
      $task = Get-CribbleTask
      if ($task.State -eq 'Running') { exit 0 }
      Start-ScheduledTask -TaskName $TaskName
      exit 0
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
