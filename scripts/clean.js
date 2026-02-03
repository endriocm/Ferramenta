const fs = require('fs');
const path = require('path');

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const removeAll = args.has('--all');

const removableDirNames = new Set([
  'dist',
  'build',
  'out',
  'release',
  'dist_electron',
  '.vite',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'coverage',
  'logs',
  '.vercel',
  '.cache_market_data',
]);

const removableFileExts = new Set(['.log', '.tmp']);

const explicitPaths = [
  'dist_electron',
  'pwr/dist',
  '.cache_market_data',
  '.vercel',
];

if (removeAll) {
  explicitPaths.push('node_modules');
  explicitPaths.push('pwr/node_modules');
}

const removed = [];

const safeRm = (targetPath) => {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
  removed.push(targetPath);
};

const walk = (dir) => {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') continue;
      if (entry.name === 'node_modules') {
        if (removeAll) {
          safeRm(fullPath);
        }
        continue;
      }
      if (removableDirNames.has(entry.name)) {
        safeRm(fullPath);
        continue;
      }
      walk(fullPath);
      continue;
    }

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (removableFileExts.has(ext)) {
        safeRm(fullPath);
      }
    }
  }
};

for (const rel of explicitPaths) {
  safeRm(path.join(root, rel));
}

walk(root);

if (removed.length) {
  console.log('Removed:');
  for (const item of removed) console.log(`- ${item}`);
} else {
  console.log('Nothing to clean.');
}