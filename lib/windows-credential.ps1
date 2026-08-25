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

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
}
"@

function Get-LastWin32Error {
  return [Runtime.InteropServices.Marshal]::GetLastWin32Error()
}

function Exit-NotFound {
  exit 44
}

function Read-SecretFromStdin {
  $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
  try {
    return $reader.ReadToEnd().Trim()
  } finally {
    $reader.Dispose()
  }
}

function Read-StoredSecret([string]$TargetName) {
  $pointer = [IntPtr]::Zero
  if (-not [CribbleCredential]::CredRead($TargetName, [CribbleCredential]::CRED_TYPE_GENERIC, 0, [ref]$pointer)) {
    if ((Get-LastWin32Error) -eq [CribbleCredential]::ERROR_NOT_FOUND) {
      Exit-NotFound
    }
    throw "CredRead failed with Win32 error $(Get-LastWin32Error)."
  }
  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CribbleCredential+CREDENTIAL])
    if ($credential.CredentialBlob -eq [IntPtr]::Zero -or $credential.CredentialBlobSize -le 0) {
      return ''
    }
    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
    return [Text.Encoding]::Unicode.GetString($bytes).TrimEnd([char]0)
  } finally {
    [CribbleCredential]::CredFree($pointer)
  }
}

try {
  switch ($Action) {
    'find' {
      [void](Read-StoredSecret $Target)
      exit 0
    }
    'read' {
      $secret = Read-StoredSecret $Target
      [Console]::Out.Write($secret)
      exit 0
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
        if (-not [CribbleCredential]::CredWrite([ref]$credential, 0)) {
          throw "CredWrite failed with Win32 error $(Get-LastWin32Error)."
        }
      } finally {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
      }
      exit 0
    }
    'delete' {
      if (-not [CribbleCredential]::CredDelete($Target, [CribbleCredential]::CRED_TYPE_GENERIC, 0)) {
        if ((Get-LastWin32Error) -eq [CribbleCredential]::ERROR_NOT_FOUND) {
          Exit-NotFound
        }
        throw "CredDelete failed with Win32 error $(Get-LastWin32Error)."
      }
      exit 0
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
