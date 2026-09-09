/** Gather notices from packages actually included by the JS bundlers. */
import fs from 'node:fs';
import path from 'node:path';
export function javascriptNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(input.replace(/^\0/, '').replace(/\?.*$/, '')));
    while (dir !== path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pkg.name && pkg.version) {
          if (pkg.private && pkg.name.startsWith("@companion/")) break;
          if (!packages.has(`${pkg.name}@${pkg.version}`)) {
            const names = fs.readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name));
            const notices = names.filter(name => fs.statSync(path.join(dir, name)).isFile()).map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') }));
            if (!notices.length) {
              for (const name of fs.readdirSync(dir).filter(name => /^readme(?:\.|$)/i.test(name))) {
                const text = fs.readFileSync(path.join(dir, name), 'utf8');
                const match = text.match(/^#+\s+licen[cs]e\b[\s\S]*/im);
                if (match) notices.push({ name, text: match[0] });
              }
            }
            if (!notices.length) throw new Error(`Missing redistribution notice for ${pkg.name}@${pkg.version}`);
            packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'SEE NOTICE', notices });
          }
          break;
        }
      }
      dir = path.dirname(dir);
    }
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}
