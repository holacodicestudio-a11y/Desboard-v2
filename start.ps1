param(
  [switch]$Lan,
  [int]$Port = 4174
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BindAddress = '127.0.0.1'

if ($Lan) {
  $privateIpPattern = '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)'
  $excludedAdapterPattern = 'loopback|wsl|vethernet|hyper-v|virtualbox|vmware|vpn|tunnel'
  $adapters = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and $_.Name -notmatch $excludedAdapterPattern }
  $selectedAddress = $null
  foreach ($adapter in $adapters) {
    $properties = $adapter.GetIPProperties()
    $hasGateway = @($properties.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.ToString() -ne '0.0.0.0' }).Count -gt 0
    $address = $properties.UnicastAddresses |
      Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.ToString() -match $privateIpPattern } |
      Select-Object -First 1
    if ($address -and $hasGateway) { $selectedAddress = $address.Address.ToString(); break }
  }
  if (-not $selectedAddress) {
    foreach ($adapter in $adapters) {
      $address = $adapter.GetIPProperties().UnicastAddresses |
        Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.Address.ToString() -match $privateIpPattern } |
        Select-Object -First 1
      if ($address) { $selectedAddress = $address.Address.ToString(); break }
    }
  }

  if (-not $selectedAddress) {
    throw 'No encontré una dirección IPv4 privada de red local. Inicia sin -Lan para usar solo esta PC.'
  }

  $BindAddress = $selectedAddress
}

Write-Host ''
Write-Host 'Northstar Market Research' -ForegroundColor Cyan
Write-Host 'Datos de mercado · solo análisis · sin órdenes' -ForegroundColor DarkGray
Write-Host ''
Write-Host ('Abre: http://' + $BindAddress + ':' + $Port) -ForegroundColor Green
if ($Lan) {
  Write-Host 'Acceso enlazado a una interfaz privada de esta PC.' -ForegroundColor DarkYellow
} else {
  Write-Host 'Acceso limitado a esta PC. Usa -Lan para la red local.' -ForegroundColor DarkGray
}
Write-Host 'Detén el servidor con Ctrl+C.' -ForegroundColor DarkGray
Write-Host ''

$env:HOST = $BindAddress
$env:PORT = [string]$Port
node (Join-Path $Root 'server.mjs')
