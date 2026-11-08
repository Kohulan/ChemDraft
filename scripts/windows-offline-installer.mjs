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
    if (/offline/i.test(content) || /offline/i.test(JSON.stringify(manifest))) {
      throw new Error(`${feed} must not mention offline installers.`);
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
