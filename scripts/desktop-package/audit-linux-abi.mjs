/** Inspect all shipped ELF objects, including bundled Node and Python extensions. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function auditLinuxAbi(root, maximum = [2, 36]) {
  const objects = [];
  function visit(directory) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) { visit(file); continue; }
      if (!item.isFile()) continue;
      const fd = fs.openSync(file, 'r'), magic = Buffer.alloc(4);
      try { fs.readSync(fd, magic, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (!magic.equals(Buffer.from([127, 69, 76, 70]))) continue;
      const text = execFileSync('readelf', ['--version-info', '--dynamic', '--wide', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const versions = [...new Set([...text.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)].map(m => m[0]))];
      for (const version of versions) {
        const [major, minor] = version.slice(6).split('.').map(Number);
        if (major > maximum[0] || (major === maximum[0] && minor > maximum[1])) throw new Error(`${path.relative(root, file)} requires ${version}; baseline is glibc ${maximum.join('.')}`);
      }
      objects.push({ path: path.relative(root, file), glibcVersions: versions, needed: [...text.matchAll(/\(NEEDED\).*\[(.*?)\]/g)].map(m => m[1]) });
    }
  }
  visit(root);
  if (!objects.length) throw new Error('No ELF objects found.');
  return { baseline: `glibc ${maximum.join('.')}`, objects };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(auditLinuxAbi(path.resolve(process.argv[2])), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
