const fs = require('fs');
const path = require('path');

const root = process.cwd();

const bannedDirNames = new Set([
  'node_modules',
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
  '__archive__',
  'legacy',
]);

const bannedDirPatterns = [
  /^pwr_baseline_/i,
  /^pwr_unzipped$/i,
  /^pwr_zip_/i,
];

const bannedFileExts = new Set(['.log', '.tmp']);

const isBannedEnv = (name) => {
  if (!name.toLowerCase().startsWith('.env')) return false;
  return name.toLowerCase() !== '.env.example';
};

const hits = [];

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

      if (bannedDirNames.has(entry.name)) {
        hits.push(fullPath);
        continue;
      }

      if (bannedDirPatterns.some((rx) => rx.test(entry.name))) {
        hits.push(fullPath);
        continue;
      }

      walk(fullPath);
      continue;
    }

    if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (bannedFileExts.has(ext) || isBannedEnv(entry.name)) {
        hits.push(fullPath);
      }
    }
  }
};

walk(root);

if (hits.length) {
  console.error('verify:clean failed. Found prohibited artifacts:');
  for (const item of hits) console.error(`- ${item}`);
  process.exit(1);
}

console.log('verify:clean ok.');