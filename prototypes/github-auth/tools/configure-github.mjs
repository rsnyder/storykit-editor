/** Operator-only setup: secret goes from a hidden terminal prompt to Wrangler stdin. */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

if (!process.stdin.isTTY) {
  console.error('Run this command in an interactive terminal. Do not pass credentials as command arguments.');
  process.exit(1);
}
const configPath = new URL('../wrangler.staging.jsonc', import.meta.url);
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch { console.error('Create wrangler.staging.jsonc as described in README.md first.'); process.exit(1); }
let hidden = false;
const output = new Writable({ write(chunk, _encoding, callback) { if (!hidden) process.stdout.write(chunk); callback(); } });
const prompt = createInterface({ input: process.stdin, output, terminal: true });
prompt.on('SIGINT', () => { process.stdout.write('\nCanceled.\n'); process.exit(1); });
console.log(`Configure GitHub sign-in for ${config.vars.APP_ORIGIN}`);
const clientId = (await prompt.question('GitHub OAuth Client ID: ')).trim();
if (!/^[A-Za-z0-9_.-]+$/.test(clientId)) { console.error('Invalid Client ID.'); prompt.close(); process.exit(1); }
process.stdout.write('GitHub OAuth Client Secret (hidden; sent directly to Cloudflare): ');
hidden = true;
const secret = (await prompt.question('')).trim();
hidden = false; process.stdout.write('\n'); prompt.close();
if (!secret || /\s/.test(secret)) { console.error('A valid Client Secret is required.'); process.exit(1); }
const wrangler = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url).pathname;
const upload = spawnSync(process.execPath, [wrangler, 'secret', 'put', 'GITHUB_CLIENT_SECRET', '--config', configPath.pathname], {
  input: secret + '\n', stdio: ['pipe', 'inherit', 'inherit'], cwd: new URL('..', import.meta.url),
});
if (upload.status !== 0) { console.error('Secret upload failed. No deployment was attempted.'); process.exit(1); }
config.vars.GITHUB_CLIENT_ID = clientId;
await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
const deploy = spawnSync(process.execPath, [wrangler, 'deploy', '--config', configPath.pathname], { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
process.exit(deploy.status ?? 1);
