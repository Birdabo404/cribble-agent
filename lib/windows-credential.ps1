param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('find', 'read', 'store', 'delete')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$Account
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Win32 Credential Manager. Never use cmdkey: it places the secret on argv.
# LastError is captured inside the C# helpers so PowerShell cannot clobber it.
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CribbleCredential
{
    public const int CRED_TYPE_GENERIC = 1;
    public const int CRED_PERSIST_LOCAL_MACHINE = 2;
    public const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);

    public static int TryRead(string target, out IntPtr credentialPtr)
    {
        if (CredRead(target, CRED_TYPE_GENERIC, 0, out credentialPtr)) return 0;
        return Marshal.GetLastWin32Error();
    }

    public static int TryWrite(ref CREDENTIAL credential)
    {
        if (CredWrite(ref credential, 0)) return 0;
        return Marshal.GetLastWin32Error();
    }

    public static int TryDelete(string target)
    {
        if (CredDelete(target, CRED_TYPE_GENERIC, 0)) return 0;
        return Marshal.GetLastWin32Error();
    }
}
"@

function Read-SecretFromStdin {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  try {
    return $reader.ReadToEnd().Trim()
  } finally {
    $reader.Dispose()
  }
}

function Read-StoredSecret([string]$TargetName) {
  [IntPtr]$pointer = [IntPtr]::Zero
  $code = [CribbleCredential]::TryRead($TargetName, [ref]$pointer)
  if ($code -eq [CribbleCredential]::ERROR_NOT_FOUND) {
    return @{ Found = $false }
  }
  if ($code -ne 0) {
    throw "CredRead failed with Win32 error $code."
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CribbleCredential+CREDENTIAL])
    $secret = ''
    if ($credential.CredentialBlob -ne [IntPtr]::Zero -and $credential.CredentialBlobSize -gt 0) {
      $bytes = New-Object byte[] $credential.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
      $secret = [Text.Encoding]::Unicode.GetString($bytes).TrimEnd([char]0)
    }
    return @{ Found = $true; Secret = $secret }
  } finally {
    [CribbleCredential]::CredFree($pointer)
  }
}

$stored = $null
$deleteCode = $null
try {
  switch ($Action) {
    'find' {
      $stored = Read-StoredSecret $Target
    }
    'read' {
      $stored = Read-StoredSecret $Target
    }
    'store' {
      $secret = Read-SecretFromStdin
      if (-not $secret) {
        throw 'No Agent key was received on stdin.'
      }
      $bytes = [Text.Encoding]::Unicode.GetBytes($secret)
      $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      try {
        [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
        $credential = New-Object CribbleCredential+CREDENTIAL
        $credential.Type = [CribbleCredential]::CRED_TYPE_GENERIC
        $credential.TargetName = $Target
        $credential.UserName = $Account
        $credential.Comment = 'Cribble Agent Key'
        $credential.CredentialBlob = $blob
        $credential.CredentialBlobSize = $bytes.Length
        $credential.Persist = [CribbleCredential]::CRED_PERSIST_LOCAL_MACHINE
        $code = [CribbleCredential]::TryWrite([ref]$credential)
        if ($code -ne 0) {
          throw "CredWrite failed with Win32 error $code."
        }
      } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
      }
    }
    'delete' {
      $deleteCode = [CribbleCredential]::TryDelete($Target)
      if ($deleteCode -ne 0 -and $deleteCode -ne [CribbleCredential]::ERROR_NOT_FOUND) {
        throw "CredDelete failed with Win32 error $deleteCode."
      }
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

if ($Action -eq 'find' -or $Action -eq 'read') {
  if (-not $stored.Found) { exit 44 }
  if ($Action -eq 'read') {
    [Console]::Out.Write($stored.Secret)
  }
  exit 0
}

if ($Action -eq 'delete') {
  if ($deleteCode -eq [CribbleCredential]::ERROR_NOT_FOUND) { exit 44 }
  exit 0
}

exit 0
