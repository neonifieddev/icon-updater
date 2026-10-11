#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Upload')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[1-9][0-9]*$')][string]$RootPlaceId,
    [Parameter(Mandatory, ParameterSetName = 'Upload')]
    [string]$ImagePath,
    [Parameter(Mandatory, ParameterSetName = 'Upload')]
    [ValidateSet('User', 'Group')][string]$CreatorType,
    [Parameter(Mandatory, ParameterSetName = 'Upload')]
    [ValidatePattern('^[1-9][0-9]*$')][string]$CreatorId,
    [Parameter(Mandatory, ParameterSetName = 'Existing')]
    [ValidatePattern('^[1-9][0-9]*$')][string]$ImageAssetId
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:ROBLOX_API_KEY)) {
    throw 'Set the ROBLOX_API_KEY environment variable first. The key needs Assets Read and Write access.'
}
$headers = @{ 'x-api-key' = $env:ROBLOX_API_KEY }
$api = 'https://apis.roblox.com/assets/v1'
$placeId = $RootPlaceId

function Wait-AssetOperation($operation) {
    if ($operation.error) { throw ($operation.error | ConvertTo-Json -Compress) }
    if ($operation.path -notmatch '^operations/[a-zA-Z0-9_-]+$') {
        return $operation
    }
    $operationPath = $operation.path
    Write-Host "Waiting for $operationPath"
    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    while (-not $operation.done) {
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for $operationPath. Check this operation before uploading again."
        }
        Start-Sleep -Seconds 2
        $operation = Invoke-RestMethod -Uri "$api/$operationPath" -Headers $headers -TimeoutSec 30
        if ($operation.error) { throw ($operation.error | ConvertTo-Json -Compress) }
    }
    return $operation.response
}

# Read before changing anything; this also provides the previous icon for rollback.
$before = Invoke-RestMethod -Uri "$api/assets/${placeId}?readMask=icon" -Headers $headers -TimeoutSec 30
Write-Host "Previous icon: $($before.icon)"

if ($PSCmdlet.ParameterSetName -eq 'Upload') {
    $file = Get-Item -LiteralPath $ImagePath
    if ($file.PSIsContainer -or $file.Length -gt 20MB) { throw 'Choose an image file no larger than 20 MB.' }
    if ($file.Extension.ToLowerInvariant() -notin @('.png', '.jpg', '.jpeg', '.bmp')) {
        throw 'Use a square PNG, JPEG, or BMP image.'
    }
    Add-Type -AssemblyName System.Drawing
    $bitmap = [System.Drawing.Image]::FromFile($file.FullName)
    try {
        if ($bitmap.Width -ne $bitmap.Height -or $bitmap.Width -ge 8000) {
            throw 'The icon must be square and smaller than 8000 x 8000 pixels.'
        }
    } finally { $bitmap.Dispose() }
    $creator = @{}
    $creator[($CreatorType.ToLowerInvariant() + 'Id')] = $CreatorId
    $request = @{
        assetType = 'Image'
        displayName = 'Experience main icon'
        description = 'Experience main icon'
        creationContext = @{ creator = $creator; expectedPrice = 0 }
    } | ConvertTo-Json -Depth 5 -Compress
    $operation = Invoke-RestMethod -Method Post -Uri "$api/assets" -Headers $headers -Form @{
        request = $request
        fileContent = $file
    } -TimeoutSec 120
    $asset = Wait-AssetOperation $operation
    $ImageAssetId = [string]$asset.assetId
    if (-not $ImageAssetId -and $asset.path -match '^assets/([0-9]+)$') { $ImageAssetId = $Matches[1] }
    if ($ImageAssetId -notmatch '^[1-9][0-9]*$') { throw 'Upload did not return an image asset ID; the place was not changed.' }
    Write-Host "Uploaded image asset: $ImageAssetId (reuse this ID instead of uploading again)"
}

$expectedIcon = "assets/$ImageAssetId"
$request = @{ assetId = $placeId; icon = $expectedIcon } | ConvertTo-Json -Compress
$result = Invoke-RestMethod -Method Patch -Uri "$api/assets/${placeId}?updateMask=icon" -Headers $headers -Form @{
    request = $request
} -TimeoutSec 60
$null = Wait-AssetOperation $result
$verified = $false
for ($attempt = 0; $attempt -lt 6; $attempt++) {
    $after = Invoke-RestMethod -Uri "$api/assets/${placeId}?readMask=icon" -Headers $headers -TimeoutSec 30
    if ($after.icon -eq $expectedIcon) { $verified = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $verified) { throw "PATCH returned successfully, but icon readback did not match $expectedIcon. Actual: $($after.icon)" }
[pscustomobject]@{
    RootPlaceId = $placeId
    PreviousIcon = $before.icon
    Icon = $after.icon
    Verified = $true
}
Write-Host 'Root place icon metadata verified. Public display may still wait for moderation or caching.'
