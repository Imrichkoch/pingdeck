param(
    [string]$AndroidSdk = $env:ANDROID_HOME,
    [string]$JdkHome = $env:JAVA_HOME,
    [string]$BuildToolsVersion = '36.1.0',
    [string]$AndroidPlatform = 'android-36',
    [string]$OutputDirectory,
    [string]$SigningDirectory
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root 'work/android-build' }
if (!$SigningDirectory) { $SigningDirectory = Join-Path $root 'work/signing' }
New-Item -ItemType Directory -Path $OutputDirectory,$SigningDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$SigningDirectory = (Resolve-Path -LiteralPath $SigningDirectory).Path
$env:TEMP = $env:TMP = $OutputDirectory
$env:JAVA_HOME = $JdkHome

$tools = Join-Path $AndroidSdk "build-tools/$BuildToolsVersion"
$platform = Join-Path $AndroidSdk "platforms/$AndroidPlatform/android.jar"
$artifacts = @{}
foreach ($name in 'classes','generated','dex') {
    $artifacts[$name] = Join-Path $OutputDirectory $name
    New-Item -ItemType Directory -Path $artifacts[$name] -Force | Out-Null
}

function Invoke-Native([string]$Path, [string[]]$Arguments) {
    if (!(Test-Path -LiteralPath $Path)) { throw "Missing Android build tool: $Path" }
    & $Path @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Path failed with exit code $LASTEXITCODE" }
}

$dependencies = Join-Path $root 'work/toolchain'
New-Item -ItemType Directory -Path $dependencies -Force | Out-Null
$qrCore = Join-Path $dependencies 'zxing-core-3.5.4.jar'
if (!(Test-Path -LiteralPath $qrCore)) {
    Invoke-WebRequest -Uri 'https://repo.maven.apache.org/maven2/com/google/zxing/core/3.5.4/core-3.5.4.jar' -OutFile $qrCore
}
if ((Get-FileHash -LiteralPath $qrCore -Algorithm SHA256).Hash -ne '71DE5D89341B5FCF5DD89DA7F44E84D825D0E084CDF3EC77C9ABE26B0F0CEB13') {
    throw 'ZXing dependency checksum mismatch.'
}

$resources = Join-Path $OutputDirectory 'resources.zip'
$unsigned = Join-Path $OutputDirectory 'unsigned.apk'
$aligned = Join-Path $OutputDirectory 'aligned.apk'
$bytecode = Join-Path $OutputDirectory 'app.jar'
$apk = Join-Path $OutputDirectory 'pingdeck.apk'

Invoke-Native "$tools/aapt2.exe" @('compile','--dir',"$PSScriptRoot/res",'-o',$resources)
Invoke-Native "$tools/aapt2.exe" @('link','-I',$platform,'--manifest',"$PSScriptRoot/AndroidManifest.xml",
    '--java',$artifacts.generated,'-A',"$PSScriptRoot/assets",'-o',$unsigned,$resources)
$sources = Get-ChildItem -Path "$PSScriptRoot/src",$artifacts.generated -Recurse -Filter '*.java' -File
Invoke-Native "$JdkHome/bin/javac.exe" (@('-encoding','UTF-8','-source','8','-target','8',
    '-classpath',($platform + [IO.Path]::PathSeparator + $qrCore),'-d',$artifacts.classes) + @($sources.FullName))
Invoke-Native "$JdkHome/bin/jar.exe" @('cf',$bytecode,'-C',$artifacts.classes,'.')
Invoke-Native "$tools/d8.bat" @('--release','--min-api','26','--lib',$platform,'--output',$artifacts.dex,$bytecode,$qrCore)
Invoke-Native "$JdkHome/bin/jar.exe" @('uf',$unsigned,'-C',$artifacts.dex,'classes.dex')
Invoke-Native "$tools/zipalign.exe" @('-f','4',$unsigned,$aligned)

$keystore = Join-Path $SigningDirectory 'pingdeck-release.p12'
$passwordFile = Join-Path $SigningDirectory 'password.dpapi'
try {
    if (Test-Path -LiteralPath $passwordFile) {
        $stored = Get-Content -LiteralPath $passwordFile | ConvertTo-SecureString
        $env:PINGDECK_APK_PASSWORD = [System.Net.NetworkCredential]::new('', $stored).Password
    } elseif (Test-Path -LiteralPath $keystore) {
        throw 'Missing signing password file.'
    } else {
        $bytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($bytes)
        $rng.Dispose()
        $env:PINGDECK_APK_PASSWORD = [Convert]::ToBase64String($bytes)
        ConvertTo-SecureString -String $env:PINGDECK_APK_PASSWORD -AsPlainText -Force |
            ConvertFrom-SecureString | Set-Content -LiteralPath $passwordFile -Encoding ascii -NoNewline
    }
    if (!(Test-Path -LiteralPath $keystore)) {
        Invoke-Native "$JdkHome/bin/keytool.exe" @('-genkeypair','-alias','pingdeck','-keyalg','RSA','-keysize','3072',
            '-sigalg','SHA256withRSA','-validity','10000','-dname','CN=PingDeck',
            '-keystore',$keystore,'-storetype','PKCS12','-storepass:env','PINGDECK_APK_PASSWORD')
    }
    Invoke-Native "$tools/apksigner.bat" @('sign','--ks',$keystore,'--ks-key-alias','pingdeck',
        '--ks-pass','env:PINGDECK_APK_PASSWORD','--out',$apk,$aligned)
    Invoke-Native "$tools/apksigner.bat" @('verify','--verbose','--print-certs',$apk)
} finally {
    Remove-Item Env:PINGDECK_APK_PASSWORD -ErrorAction SilentlyContinue
}

Get-Item -LiteralPath $apk
