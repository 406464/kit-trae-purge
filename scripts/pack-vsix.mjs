#!/usr/bin/env node
/**
 * 打出 TRAE 可直接导入的 .vsix。
 *
 * VSIX 就是个 zip，结构固定：
 *   extension.vsixmanifest
 *   [Content_Types].xml
 *   extension/…
 *
 * 手写而不是依赖 vsce：本机不装 npm 依赖也能产出，别的机器也一样。
 *
 * @author 署名：406464 — 大肥鱼 @ DeepSeek Harness
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, collectFiles } from '../lib/zip.mjs';
import { attest } from './attest.mjs';
import { scrub } from './scrub.mjs';
import { parseArgs, log, head, ok, bad, info } from '../lib/cli.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(PKG_DIR, 'extension');

const UUID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

function vsixManifest(pkg) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName ?? pkg.name}</DisplayName>
    <Description xml:space="preserve">${pkg.description ?? ''}</Description>
    <Tags>${(pkg.tags ?? []).join(',')}</Tags>
    <Categories>${(pkg.categories ?? []).join(',')}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines?.vscode ?? '^1.90.0'}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${pkg.repository ?? ''}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Pricing" Value="Free" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="xml" ContentType="text/xml" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
`;

function main() {
  const args = parseArgs();
  const pkg = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'package.json'), 'utf8'));

  head('VSIX 打包前检查');
  const at = attest(PKG_DIR);
  if (!at.ok) {
    for (const i of at.issues) bad(i);
    bad('署名检查未过，拒绝打包。');
    return 1;
  }
  ok(`署名检查通过（${at.checks} 处）`);
  const sc = scrub(PKG_DIR, []);
  if (!sc.ok) {
    for (const i of sc.issues.filter((x) => x.level === 'FAIL')) bad(`${i.rel} — ${i.note}`);
    bad('隐私扫描未过，拒绝打包。');
    return 1;
  }
  ok('隐私扫描通过');

  head('打包');
  const files = collectFiles(EXT_DIR, { skip: ['node_modules', '.git', '.vscode-test'] });
  // 词库按 CLI 同一口径整份进包（排除 README*）：只塞 core.md 会让两条安装路径
  // 产出不同的规则正文与指纹。
  const wordsDir = path.join(PKG_DIR, 'words');
  let wordFiles = [];
  try {
    wordFiles = fs
      .readdirSync(wordsDir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => !f.toLowerCase().startsWith('readme'))
      .sort();
  } catch {
    wordFiles = [];
  }
  if (!wordFiles.length) {
    bad('找不到 words/ 下的 .md 词库，无法打出 VSIX。');
    return 1;
  }
  const entries = [
    { name: 'extension.vsixmanifest', data: vsixManifest(pkg) },
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    ...wordFiles.map((f) => ({ name: `extension/words/${f}`, data: fs.readFileSync(path.join(wordsDir, f)) })),
    ...files
      .filter((f) => !f.name.startsWith('words/'))
      .map((f) => ({ name: `extension/${f.name}`, data: f.data })),
  ];
  info(`词库进包：${wordFiles.join(' , ')}`);
  const zip = buildZip(entries);

  const distDir = path.join(PKG_DIR, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const out = path.join(distDir, `${pkg.name}-${pkg.version}.vsix`);
  fs.writeFileSync(out, zip);
  ok(`已产出 ${out}（${(zip.length / 1024).toFixed(1)} KB，${files.length} 个扩展文件）`);
  info('安装：TRAE 扩展面板 → 右上角「…」 → 从 VSIX 安装… → 选这个文件。');
  log('');
  return 0;
}

process.exit(main());
