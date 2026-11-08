import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkUpdaterArtifacts, offlineConfig } from './windows-offline-installer.mjs';

const script = fileURLToPath(new URL('./windows-offline-installer.mjs', import.meta.url));
const readConfig = (name) => JSON.parse(readFileSync(new URL(`../apps/desktop/src-tauri/${name}`, import.meta.url), 'utf8'));

function withDirectory(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'chemdraft-offline-'));
  try { fn(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('offline overlay changes only WebView2 packaging and updater artifact creation', () => {
  assert.deepEqual(offlineConfig, {
    bundle: {
      createUpdaterArtifacts: false,
      windows: { webviewInstallMode: { type: 'offlineInstaller', silent: true } },
    },
  });
  const allusers = readConfig('tauri.allusers.conf.json');
  assert.equal(allusers.bundle.windows.nsis.installMode, 'perMachine');
  assert.deepEqual(allusers.plugins.updater.endpoints, [
    'https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest-allusers.json',
  ]);
  const windows = readConfig('tauri.windows.conf.json');
  assert.deepEqual(windows.bundle.fileAssociations.flatMap((association) => association.ext), ['chemdraft']);
});

test('config CLI writes the minimal overlay to a path containing spaces', () => withDirectory((directory) => {
  const output = join(directory, 'offline config.json');
  const result = spawnSync(process.execPath, [script, 'config', output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), offlineConfig);
}));

test('allows normal feeds and missing feeds for unsigned dry runs', () => withDirectory((directory) => {
  writeFileSync(join(directory, 'ChemDraft_1.0.0_x64-allusers-offline-setup.exe'), 'installer');
  checkUpdaterArtifacts(directory);
  for (const suffix of ['', '-allusers']) {
    writeFileSync(join(directory, `latest${suffix}.json`), JSON.stringify({
      platforms: { 'windows-x86_64': { url: `https://example.com/ChemDraft_1.0.0_x64${suffix}-setup.exe` } },
    }));
  }
  const result = spawnSync(process.execPath, [script, 'check', directory], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}));

for (const feed of ['latest.json', 'latest-allusers.json']) {
  test(`rejects offline references and malformed JSON in ${feed}`, () => withDirectory((directory) => {
    const path = join(directory, feed);
    for (const content of [
      { platforms: { 'windows-x86_64': { url: 'https://example.com/ChemDraft_1.0.0_x64-allusers-OFFLINE-setup.exe' } } },
      { notes: 'offline' },
    ]) {
      writeFileSync(path, JSON.stringify(content));
      assert.throws(() => checkUpdaterArtifacts(directory), { message: `${feed} must not mention offline installers.` });
    }
    writeFileSync(path, '{"url":"https://example.com/allusers-\\u006fffline-setup.exe"}');
    assert.throws(() => checkUpdaterArtifacts(directory), /must not mention offline installers/);
    const result = spawnSync(process.execPath, [script, 'check', directory], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not mention offline installers/);
    writeFileSync(path, '{ malformed');
    assert.throws(() => checkUpdaterArtifacts(directory), { message: `${feed} contains invalid JSON.` });
  }));
}

test('rejects offline updater signatures and fails the check CLI', () => withDirectory((directory) => {
  writeFileSync(join(directory, 'ChemDraft_1.0.0_x64-allusers-offline-setup.exe.sig'), 'signature');
  assert.throws(() => checkUpdaterArtifacts(directory), /must not have an updater signature/);
  const result = spawnSync(process.execPath, [script, 'check', directory], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not have an updater signature/);
}));

const hasPowerShell = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']).status === 0;

test('workflow signs and verifies updater targets while excluding offline media', { skip: !hasPowerShell }, () => withDirectory((directory) => {
  const workflow = readFileSync(new URL('../.github/workflows/windows-release.yml', import.meta.url), 'utf8');
  const stepScript = (name) => {
    const step = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
    const source = step?.split('        run: |\n')[1];
    assert.ok(source, `Missing workflow script: ${name}`);
    return source.split('\n').map((line) => line.replace(/^          /, '')).join('\n');
  };
  const installers = [
    { Installer: 'ChemDraft_1.0.0_x64-setup.exe', Feed: 'latest.json' },
    { Installer: 'ChemDraft_1.0.0_x64-allusers-setup.exe', Feed: 'latest-allusers.json' },
    { Installer: 'ChemDraft_1.0.0_x64-allusers-offline-setup.exe', Feed: '' },
  ];
  // Execute the workflow's scripts with mocked tools; no builds or signing keys are used.
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
function node { Write-Output (ConvertTo-Json -InputObject @('sign', $args) -Depth 4 -Compress) }
function pnpm { Write-Output (ConvertTo-Json -InputObject @('verify-or-manifest', $args) -Depth 4 -Compress) }
${stepScript('Sign final installers for the Tauri updater')}
${stepScript('Verify updater signatures and generate latest.json and latest-allusers.json')}
`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      INSTALLERS: JSON.stringify(installers),
      VERSION: '1.0.0',
      NOTES_FILE: '',
      TAURI_SIGNING_PRIVATE_KEY: 'mock-key',
      GITHUB_OUTPUT: join(directory, 'output'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(calls.filter(([kind]) => kind === 'sign').length, 2);
  assert.equal(calls.filter(([kind]) => kind === 'verify-or-manifest').length, 4);
  assert.doesNotMatch(result.stdout, /offline/i);
  for (const { Installer, Feed } of installers.slice(0, 2)) {
    assert.ok(result.stdout.includes(Installer));
    assert.ok(result.stdout.includes(Feed));
  }
}));
