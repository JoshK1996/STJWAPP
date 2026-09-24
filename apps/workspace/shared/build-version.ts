import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Exact release inputs only. No Git metadata, timestamps, credentials, logs or local databases.
const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'Dockerfile', '.dockerignore'];
const folders = ['src', 'server', 'shared', 'public'];

/** Same source bytes produce the same identity in the review build and Railway container. */
export function buildVersion(root: string): string {
  const paths = [...files];
  const visit = (relative: string) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = `${relative}/${name}`;
      const info = lstatSync(join(root, path));
      if (info.isSymbolicLink()) throw new Error('Release inputs must not contain symbolic links.');
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) paths.push(path);
    }
  };
  folders.forEach(visit);
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    const content = readFileSync(join(root, path));
    hash.update(path).update('\0').update(String(content.length)).update('\0').update(content);
  }
  return hash.digest('hex');
}
