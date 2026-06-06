const fs = require('fs');
const path = require('node:path');

const LOG_TAG = '[sync-xmr-resources]';
const targetArg = process.argv[2];
const checkOnly = process.argv.includes('--check-source');

if (!targetArg) {
  throw new Error('Resource path argument is not set');
}

const frontendRoot = __dirname;
const sourceRoot = path.resolve(frontendRoot, 'src/resources');
const targetRoot = path.resolve(frontendRoot, targetArg);

const allowedResources = [
  '.gitkeep',
  'config.js',
  'config.template.js',
  'customize.js',
  'favicons',
  'previews/about.jpg',
  'previews/blocks.jpg',
  'previews/dashboard.png',
  'previews/docs-api.jpg',
  'previews/faq.jpg',
  'previews/privacy-policy.jpg',
  'previews/terms-of-service.jpg',
  'previews/trademark-policy.jpg',
  'sounds',
  'mining-pools/2miners.svg',
  'mining-pools/default.svg',
  'mining-pools/default.light.svg',
  'mining-pools/hashvault.svg',
  'mining-pools/herominers.svg',
  'mining-pools/moneroocean.svg',
  'mining-pools/nanopool.svg',
  'mining-pools/p2pool.svg',
  'mining-pools/supportxmr.svg',
  'mining-pools/unknown.svg',
  'mining-pools/unknown.light.svg',
];

const assertInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside ${root}: ${candidate}`);
  }
};

const copyEntry = (relativePath) => {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  assertInside(sourceRoot, source);
  assertInside(targetRoot, target);

  if (!fs.existsSync(source)) {
    throw new Error(`Required XMR resource is missing: ${relativePath}`);
  }

  if (checkOnly) {
    return 0;
  }

  const stat = fs.statSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (stat.isDirectory()) {
    fs.cpSync(source, target, { recursive: true });
    return fs.readdirSync(source, { recursive: true }).length;
  }

  fs.copyFileSync(source, target);
  return 1;
};

let copied = 0;

if (!checkOnly) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(targetRoot, { recursive: true });
}

for (const resource of allowedResources) {
  copied += copyEntry(resource);
}

if (checkOnly) {
  console.log(`${LOG_TAG} verified ${allowedResources.length} XMR resource entries in ${targetRoot}`);
} else {
  console.log(`${LOG_TAG} copied XMR resource allowlist to ${targetRoot} (${copied} filesystem entries)`);
}
