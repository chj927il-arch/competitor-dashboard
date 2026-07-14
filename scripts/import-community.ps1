# 커뮤니티 모니터링 엑셀(.xlsx) → public/data/community.json 변환
# 사용법: powershell -ExecutionPolicy Bypass -File scripts\import-community.ps1 "엑셀경로.xlsx"
param([string]$src)
if (-not $src) { $src = "Y:\VOL1\Cloud_가맹사업성장실_사업팀\커뮤니티 모니터링\2026\ECI 사업팀_26년 온라인 커뮤니티 모니터링 리포트v260610.xlsx" }
if (-not (Test-Path $src)) { Write-Error "파일 없음: $src"; exit 1 }

$tmp = Join-Path $env:TEMP ("xlc_" + (Get-Random)); New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item $src "$tmp\f.zip"; Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory("$tmp\f.zip", "$tmp\x")

$ss = @()
if (Test-Path "$tmp\x\xl\sharedStrings.xml") {
  [xml]$s = Get-Content "$tmp\x\xl\sharedStrings.xml" -Encoding UTF8
  foreach ($si in $s.sst.si) { $ss += ,(($si.SelectNodes('.//*[local-name()="t"]') | ForEach-Object { [string]$_.'#text' }) -join '') }
}
[xml]$wb = Get-Content "$tmp\x\xl\workbook.xml" -Encoding UTF8
[xml]$rel = Get-Content "$tmp\x\xl\_rels\workbook.xml.rels" -Encoding UTF8
$map = @{}; $rel.Relationships.Relationship | ForEach-Object { $map[$_.Id] = $_.Target }

function ColIndex($ref) {
  $m = [regex]::Match($ref, '^([A-Z]+)'); $letters = $m.Groups[1].Value; $n = 0
  foreach ($ch in $letters.ToCharArray()) { $n = $n * 26 + ([int][char]$ch - 64) }
  return ($n - 1)
}
function CellVal($c) { $v = $c.v; if ($c.t -eq 's' -and $v -ne $null) { return [string]$ss[[int]$v] }; return [string]$v }
function SerialToDate($v) { try { $d = [double]$v; if ($d -gt 20000 -and $d -lt 80000) { return ([DateTime]::new(1899,12,30)).AddDays($d).ToString('yyyy-MM-dd') } } catch {}; return [string]$v }
function FindCol($hdr, $key) { foreach ($k in $hdr.Keys) { if ($hdr[$k] -like "*$key*") { return $k } }; return -1 }
function Cell($cells, $ci) { if ($ci -ge 0 -and $cells.ContainsKey($ci)) { return ([string]$cells[$ci]).Trim() }; return "" }

function ReadSheet($name, $isSelf) {
  $result = @()
  $sh = $wb.workbook.sheets.sheet | Where-Object { $_.name -eq $name }
  if (-not $sh) { return $result }
  $rid = $sh.'id'; if (-not $rid) { $rid = $sh.'r:id' }
  $sheetTarget = $map[$rid]
  [xml]$sheet = Get-Content ("$tmp\x\xl\" + ($sheetTarget -replace '/','\')) -Encoding UTF8
  # 하이퍼링크 대상(행번호 -> URL) 로드: 시트 rels에서 [바로가기] 링크 주소 추출
  $hyperByRow = @{}
  $relPath = "$tmp\x\xl\worksheets\_rels\" + (Split-Path $sheetTarget -Leaf) + ".rels"
  if ((Test-Path $relPath) -and $sheet.worksheet.hyperlinks) {
    $rt = @{}; [xml]$hr = Get-Content $relPath -Encoding UTF8
    $hr.Relationships.Relationship | ForEach-Object { $rt[$_.Id] = $_.Target }
    foreach ($h in $sheet.worksheet.hyperlinks.hyperlink) {
      $tid = $h.'id'; if (-not $tid) { $tid = $h.GetAttribute('r:id') }
      $tgt = $rt[$tid]
      if ($tgt -and $tgt -match '^https?://') { $rn = [regex]::Match($h.ref, '\d+').Value; if ($rn) { $hyperByRow[$rn] = $tgt } }
    }
  }
  $rows = @($sheet.worksheet.sheetData.row)
  if ($rows.Count -lt 2) { return $result }
  $hdr = @{}
  foreach ($c in $rows[0].c) { $hdr[(ColIndex $c.r)] = (CellVal $c).Trim() }
  $cDate = FindCol $hdr '일자'; $cComm = FindCol $hdr '커뮤니티'; $cBrand = FindCol $hdr '브랜드'
  $cSum = FindCol $hdr '내용요약'; $cSent = FindCol $hdr '평가구분'
  $cCat = FindCol $hdr '평가항목'; $cReg = FindCol $hdr '지역'
  for ($i = 1; $i -lt $rows.Count; $i++) {
    $cells = @{}
    foreach ($c in $rows[$i].c) { $cells[(ColIndex $c.r)] = CellVal $c }
    $community = Cell $cells $cComm
    $summary = Cell $cells $cSum
    # URL: 행의 셀 중 http로 시작하는 값 우선, 없으면 [바로가기] 하이퍼링크 대상
    $url = ""
    foreach ($v in $cells.Values) { if ("$v" -match '^https?://') { $url = ("$v").Trim(); break } }
    if (-not $url) { $rn = $rows[$i].r; if ($rn -and $hyperByRow.ContainsKey($rn)) { $url = $hyperByRow[$rn] } }
    if ($community -match '작성글') { continue }
    if (-not $summary -and -not $url) { continue }
    $brand = if ($isSelf) { '이투스247' } else { Cell $cells $cBrand }
    $result += ,([ordered]@{
      date = SerialToDate (Cell $cells $cDate); community = $community; brand = $brand;
      region = Cell $cells $cReg; category = Cell $cells $cCat; sentiment = Cell $cells $cSent;
      summary = $summary; url = $url; self = [bool]$isSelf
    })
  }
  return $result
}

$rec = @()
$rec += ReadSheet 'Daily(경쟁사)' $false
$rec += ReadSheet 'Daily(자사)' $true

$obj = [ordered]@{ updatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssZ'); source = (Split-Path $src -Leaf); total = $rec.Count; records = $rec }
$outPath = Join-Path (Split-Path $PSScriptRoot -Parent) "public\data\community.json"
$obj | ConvertTo-Json -Depth 6 | Out-File -FilePath $outPath -Encoding utf8
Write-Output ("완료: " + $rec.Count + "건 -> " + $outPath)
Remove-Item $tmp -Recurse -Force
