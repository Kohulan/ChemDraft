import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Merge after the all-users overlay; install scope, updater endpoint and associations are inherited.
export const offlineConfig = {
  bundle: {
    createUpdaterArtifacts: false,
    windows: { webviewInstallMode: { type: 'offlineInstaller', silent: true } },
  },
};

// The offline variant is staged as ChemDraft_<ver>_x64-allusers-offline-setup.exe
// (`tools/release/record-build.mjs` BUILD_TARGETS). Check the file name a URL downloads.
function urlFileName(url) {
  const path = url.split(/[?#]/)[0];
  const name = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function checkUpdaterArtifacts(directory) {
  const files = readdirSync(directory);
  if (files.some((name) => /offline.*\.sig$/i.test(name))) {
    throw new Error('Offline installer must not have an updater signature.');
  }
  for (const feed of ['latest.json', 'latest-allusers.json']) {
    // Unsigned dispatch dry runs do not generate feeds.
    if (!files.includes(feed)) continue;
    const content = readFileSync(join(directory, feed), 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch (error) {
      throw new Error(`${feed} contains invalid JSON.`, { cause: error });
    }
    // Release notes may talk about the offline installer; a download URL must never deliver it.
    const platforms = manifest && typeof manifest === 'object' ? manifest.platforms : undefined;
    for (const entry of Object.values(platforms && typeof platforms === 'object' ? platforms : {})) {
      const url = entry && typeof entry === 'object' ? entry.url : undefined;
      if (typeof url === 'string' && /offline/i.test(urlFileName(url))) {
        throw new Error(`${feed} must not point at offline installers.`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, ...extra] = process.argv.slice(2);
  if (!target || extra.length) throw new Error('Expected config <output path> or check <artifact directory>.');
  if (command === 'config') writeFileSync(target, `${JSON.stringify(offlineConfig, null, 2)}\n`);
  else if (command === 'check') checkUpdaterArtifacts(target);
  else throw new Error('Expected config or check.');
}
