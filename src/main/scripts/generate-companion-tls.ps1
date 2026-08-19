param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [Parameter(Mandatory = $true)]
  [string]$PfxPassword,

  [Parameter()]
  [string[]]$HostName = @(),

  [Parameter()]
  [string]$HostNamesJson = ''
)

$ErrorActionPreference = 'Stop'

$caFriendlyName = 'LocalAgent Companion CA'
$leafFriendlyName = 'LocalAgent Companion Server'
$caPath = Join-Path $OutputDir 'localagent-companion-ca.cer'
$pfxPath = Join-Path $OutputDir 'localagent-companion-server.pfx'

function Get-OrCreateRootCertificate {
  $existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.FriendlyName -eq $caFriendlyName -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

  if ($existing) {
    return $existing
  }

  return New-SelfSignedCertificate `
    -Type Custom `
    -Subject 'CN=LocalAgent Companion CA' `
    -FriendlyName $caFriendlyName `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -KeyUsageProperty All `
    -KeyUsage CertSign, CRLSign, DigitalSignature `
    -NotAfter (Get-Date).AddYears(10) `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @(
      '2.5.29.19={critical}{text}CA=true&pathlength=1'
    )
}

function Ensure-RootTrusted([string]$certificatePath, [string]$thumbprint) {
  $existing = Get-ChildItem Cert:\CurrentUser\Root |
    Where-Object { $_.Thumbprint -eq $thumbprint } |
    Select-Object -First 1

  if ($existing) {
    return
  }

  Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
}

function Remove-ExistingLeafCertificates {
  Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.FriendlyName -eq $leafFriendlyName } |
    ForEach-Object {
      Remove-Item -Path $_.PSPath -Force
    }
}

function Build-SanExtension([string[]]$hosts) {
  $dnsHosts = @()
  $ipHosts = @()

  foreach ($entry in $hosts) {
    $normalized = [string]$entry
    if ([string]::IsNullOrWhiteSpace($normalized)) {
      continue
    }
    if ($normalized -match '^\d{1,3}(?:\.\d{1,3}){3}$') {
      $ipHosts += $normalized
    } else {
      $dnsHosts += $normalized
    }
  }

  $parts = @()
  foreach ($dns in ($dnsHosts | Select-Object -Unique)) {
    $parts += "DNS=$dns"
  }
  foreach ($ip in ($ipHosts | Select-Object -Unique)) {
    $parts += "IPAddress=$ip"
  }

  return '2.5.29.17={text}' + ($parts -join '&')
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$hosts = @('localhost', '127.0.0.1')
if (-not [string]::IsNullOrWhiteSpace($HostNamesJson)) {
  $parsedHosts = ConvertFrom-Json -InputObject $HostNamesJson
  foreach ($entry in @($parsedHosts)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
      $hosts += [string]$entry
    }
  }
}
foreach ($entry in $HostName) {
  if (-not [string]::IsNullOrWhiteSpace($entry)) {
    $hosts += [string]$entry
  }
}
$hosts = $hosts | Select-Object -Unique

$rootCert = Get-OrCreateRootCertificate
Export-Certificate -Cert $rootCert -FilePath $caPath -Force | Out-Null
Ensure-RootTrusted -certificatePath $caPath -thumbprint $rootCert.Thumbprint

Remove-ExistingLeafCertificates

$sanExtension = Build-SanExtension -hosts $hosts
$ekuExtension = '2.5.29.37={text}1.3.6.1.5.5.7.3.1'
$leafCert = New-SelfSignedCertificate `
  -Type Custom `
  -Subject 'CN=LocalAgent Companion' `
  -FriendlyName $leafFriendlyName `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(2) `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -Signer $rootCert `
  -TextExtension @($sanExtension, $ekuExtension)

$password = ConvertTo-SecureString -String $PfxPassword -Force -AsPlainText
Export-PfxCertificate `
  -Cert $leafCert `
  -FilePath $pfxPath `
  -Password $password `
  -ChainOption BuildChain `
  -Force | Out-Null

@{
  success = $true
  caThumbprint = $rootCert.Thumbprint
  caFingerprint = $rootCert.Thumbprint
  leafThumbprint = $leafCert.Thumbprint
  leafFingerprint = $leafCert.Thumbprint
  caPath = $caPath
  pfxPath = $pfxPath
} | ConvertTo-Json -Compress
