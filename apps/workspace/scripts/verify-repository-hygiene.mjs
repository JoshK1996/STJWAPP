/**
 * Validate the explicit publication boundary, without printing matched content.
 * Default: read only staged/tracked blobs in the current application directory.
 * --manifest PATH: inspect exactly those workspace-relative regular files before staging.
 * The JSON manifest is an array of path strings, or { files: [path, ...] }.
 * This is a deterministic guard, not a guarantee that no sensitive data exists.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const rootFiles = new Set([
  '.dockerignore', '.gitignore', '.gitattributes', 'AGENTS.md', 'README.md', 'Dockerfile',
  'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
]);
const deniedParts = new Set([
  '.git', '.env', '.reference', '.work', '.local', '.railway', '.playwright-cli',
  'node_modules', 'dist', 'output', 'coverage', '__pycache__', 'undefined',
  'playwright-report', 'test-results',
]);
const sourceExtension = /\.(?:ts|tsx|mts|js|mjs|cjs|css)$/;
const pausedImplementation = /(?:^|\/)(?:finance-attachment[^/]*|finance-object-store[^/]*)(?:\.|\/|$)|^integrations\/finance-scanner\//i;
const artifacts = /\.(?:pem|key|p12|pfx|sqlite3?|db|dump|backup|har|log|csv|xlsx?|pdf|zip|tgz|gz|pyc|pyo)$/i;
const confidentialName = /(?:credentials?\.(?:json|txt|ya?ml)$|private[-_]key|do[-_]not[-_]open|student[-_]records|school[-_]records|production[-_](?:data|database))/i;
// One-way fingerprints of deployment-account identities. Do not publish the
// names/addresses themselves in fixtures, defaults, operational notes or docs.
const privateIdentityDigests = new Set([
  "e074d84c965feb6cb30318b5dde43d61f73aaa38ee73c4b15b559a2694552bac",
  "174762c42388a3bd24dbb9d7a984c2f63c996f697d8d60e94396c2fcb390024f",
  "8df71b4d8b0cd869fb26103c6f2a27929237d5e60e731e0a3022f85fc1499c77",
  "f7fa8da24bf4b8452b1e78fd0318daec3b08fdbad83ee67aa1d8b051de108026",
  "f71d714fd3f6336b07b448afdecb9b94ee44f37ee1ff4ace06dd47db75e68d7d",
  "77204a538d7c2a36000444e95590f2d4d2616ebf18438368958e76bd7d10af14"
]);
function hasPrivateIdentity(text) {
  const candidates = text.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|(?=\b([A-Za-z]{2,30}\s+[A-Za-z]{2,30})\b)/g);
  for (const candidate of candidates) {
    const normalized = (candidate[1] ?? candidate[0]).toLowerCase().replace(/\s+/g, ' ');
    if (privateIdentityDigests.has(createHash('sha256').update(normalized).digest('hex'))) return true;
  }
  return false;
}
const secretPatterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['stripe-secret', /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{24,}\b/],
];

export function allowedPublicationPath(file) {
  if (typeof file !== 'string' || !file || /[\\\x00-\x1f\x7f]/.test(file) || path.posix.isAbsolute(file)) return false;
  const parts = file.split('/');
  if (parts.some(part => !part || part === '..' || part === '.' || deniedParts.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) return false;
  if (artifacts.test(file) || confidentialName.test(path.posix.basename(file))) return false;
  // Paused code/tests may not enter the current application's publication boundary.
  // Design documentation remains publishable and must accurately label its status.
  if (!file.startsWith('docs/') && pausedImplementation.test(file)) return false;
  if (rootFiles.has(file)) return true;
  if (/^(?:src|shared)\//.test(file)) return sourceExtension.test(file);
  if (/^server\/migrations\/\d{3}_[a-z0-9_-]+\.sql$/.test(file)) return true;
  if (/^server\//.test(file)) return sourceExtension.test(file);
  if (/^tests\/[a-z0-9][a-z0-9-]*\.test\.(?:ts|mjs)$/.test(file)) return true;
  if (/^scripts\/[a-z0-9][a-z0-9-]*\.(?:ts|mjs|ps1|py)$/.test(file)) return true;
  if (/^docs\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(file) || file === 'docs/openapi.json') return true;
  if (file === 'public/fonts.css' || file === 'public/manifest.webmanifest' || /^public\/art\/stjw-(?:community|day)\.(?:png|webp)$/.test(file)) return true;
  if (['public/art/school-front.webp', 'public/art/school-front-640.webp', 'public/art/chapel-window.webp', 'public/art/school-crest.png', 'public/icons/stjw-192.png', 'public/icons/stjw-512.png', 'public/icons/stjw-maskable-512.png', 'public/icons/apple-touch-icon.png'].includes(file)) return true;
  if (/^integrations\/mcp\/(?:package(?:-lock)?\.json|tsconfig\.json|README\.md|\.gitignore)$/.test(file)) return true;
  if (/^integrations\/mcp\/(?:src|tests|scripts)\/[a-z0-9][a-z0-9-]*(?:\.test)?\.(?:ts|mjs)$/.test(file)) return true;
  return false;
}

function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, { cwd, encoding, maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function run() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--manifest')) throw new Error('Usage: node scripts/verify-repository-hygiene.mjs [--manifest PATH]');
  const cwd = realpathSync(process.cwd());
  const problems = [];
  let entries;
  if (args.length) {
    const manifest = JSON.parse(readFileSync(path.resolve(args[1]), 'utf8'));
    const files = Array.isArray(manifest) ? manifest : manifest.files;
    if (!Array.isArray(files) || files.length === 0 || files.some(file => typeof file !== 'string')) throw new Error('Manifest must contain a nonempty array of explicit relative paths.');
    if (new Set(files).size !== files.length) throw new Error('Manifest contains duplicate paths.');
    entries = files.map(file => ({ file, source: 'filesystem' }));
  } else {
    const prefix = git(['rev-parse', '--show-prefix'], cwd).trim();
    entries = git(['ls-files', '--stage', '--full-name', '-z', '--', '.'], cwd).split('\0').filter(Boolean).map(line => {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/.exec(line);
      if (!match || !match[4].startsWith(prefix)) throw new Error('Invalid Git index entry.');
      return { file: match[4].slice(prefix.length), source: 'index', mode: match[1], stage: match[3], oid: match[2] };
    });
    if (!entries.length) throw new Error('No tracked application files; use an explicit reviewed --manifest before staging.');
  }
  const digest = createHash('sha256');
  let textFiles = 0;
  for (const entry of entries.sort((a, b) => a.file.localeCompare(b.file))) {
    if (!allowedPublicationPath(entry.file)) {
      problems.push({ file: entry.file, rule: 'outside-publication-allowlist' });
      continue; // Never open forbidden credential, data or reference paths.
    }
    if (entry.source === 'index' && (!['100644', '100755'].includes(entry.mode) || entry.stage !== '0')) {
      problems.push({ file: entry.file, rule: 'nonregular-or-unmerged-index-entry' });
      continue;
    }
    let bytes;
    if (entry.source === 'index') {
      bytes = git(['cat-file', 'blob', entry.oid], cwd, 'buffer');
    } else {
      const target = path.resolve(cwd, ...entry.file.split('/'));
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || !realpathSync(target).startsWith(cwd + path.sep)) {
        problems.push({ file: entry.file, rule: 'nonregular-or-external-file' });
        continue;
      }
      if (stat.size > 10 * 1024 * 1024) {
        problems.push({ file: entry.file, rule: 'file-over-10-mib' });
        continue;
      }
      bytes = readFileSync(target);
    }
    if (bytes.length > 10 * 1024 * 1024) {
      problems.push({ file: entry.file, rule: 'file-over-10-mib' });
      continue;
    }
    digest.update(entry.file).update('\0').update(createHash('sha256').update(bytes).digest()).update('\0');
    if (/\.(?:png|webp)$/.test(entry.file)) continue;
    textFiles++;
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { problems.push({ file: entry.file, rule: 'invalid-text-encoding' }); continue; }
    if (text.includes('\0')) problems.push({ file: entry.file, rule: 'null-in-text' });
    if (hasPrivateIdentity(text)) problems.push({ file: entry.file, rule: 'private-account-identity' });
    for (const [rule, pattern] of secretPatterns) {
      if (pattern.test(text)) problems.push({ file: entry.file, rule });
    }
    if (entry.file === 'package.json') {
      const pkg = JSON.parse(text);
      if (pkg.dependencies?.['@aws-sdk/client-s3'] || pkg.dependencies?.['@smithy/node-http-handler']) {
        problems.push({ file: entry.file, rule: 'paused-finance-dependency' });
      }
    }
  }
  process.stdout.write(JSON.stringify({ ok: problems.length === 0, files: entries.length, textFiles, digest: digest.digest('hex'), problems }, null, 2) + '\n');
  if (problems.length) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  try { run(); } catch { process.stderr.write('Repository hygiene could not complete. Check arguments, index and manifest paths; file contents were not printed.\n'); process.exitCode = 1; }
}
