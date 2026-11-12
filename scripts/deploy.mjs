// Builds the app and publishes it to the gh-pages branch, which GitHub Pages serves.
// Run with `npm run deploy` after the code is committed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
const read = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

if (read('git', ['status', '--porcelain'])) throw new Error('Commit your changes first, so the site matches a commit.');
const origin = read('git', ['remote', 'get-url', 'origin']);
const commit = read('git', ['rev-parse', '--short', 'HEAD']);

run('npx', ['vite', 'build']);
writeFileSync('dist/.nojekyll', '');

// A fresh repository each time, so the branch holds only the built site.
const work = mkdtempSync(join(tmpdir(), 'fleet-lite-pages-'));
run('cp', ['-R', 'dist/.', work]);
run('git', ['init', '-q', '-b', 'gh-pages'], work);
run('git', ['add', '-A'], work);
run('git', ['-c', 'user.name=fleet-lite deploy', '-c', 'user.email=deploy@users.noreply.github.com', 'commit', '-q', '-m', `Deploy ${commit}`], work);
run('git', ['push', '-q', '-f', origin, 'gh-pages'], work);
rmSync(work, { recursive: true, force: true });
console.log(`Deployed ${commit} to gh-pages.`);
