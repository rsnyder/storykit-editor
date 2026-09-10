import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { commitPackage, reconcilePackage, operationMarker } from '../src/package-commit.js';
const sha = s => createHash('sha1').update(s).digest('hex');
const digest = 'b'.repeat(64);
const additions = [['_posts/2026-09-07-proof.md', 'source'], ['_data/storykit_workspaces/proof.json', '{}'], ['assets/posts/proof/a.png', '\x89PNG'], ['assets/posts/proof/b.png', '\x89PNG other']].map(([path, text]) => ({ path, contents: Buffer.from(text).toString('base64') }));
function git() {
  let head = sha('initial');
  let tree = { 'README.md': 'untouched' }; const history = []; let calls = 0;
  return {
    get head() { return head; }, get tree() { return tree; }, history,
    get calls() { return calls; },
    async graphql({ query, variables: { input } }) {
      calls++;
      assert.match(query, /createCommitOnBranch/);
      assert.equal(input.branch.repositoryNameWithOwner, 'test/disposable');
      assert.equal(input.branch.branchName, 'proof');
      assert(!input.fileChanges.deletions);
      if (input.expectedHeadOid !== head) return { errors: [{ type: 'STALE_DATA' }] };
      const parent = head;
      tree = { ...tree, ...Object.fromEntries(input.fileChanges.additions.map(a => [a.path, a.contents])) };
      head = sha(JSON.stringify({ tree, parent }));
      history.unshift({ oid: head, message: input.message.headline + '\n\n' + input.message.body, tree: { ...tree } });
      return { data: { createCommitOnBranch: { commit: { oid: head, url: 'https://github.com/test/disposable/commit/' + head } } } };
    },
  };
}
function args(g, patch = {}) { return { graphql: g.graphql, repository: 'test/disposable', branch: 'proof', expectedHead: g.head, operationId: 'operation_1', digest, additions, ...patch }; }

test('one atomic mutation includes all files, retains unrelated tree entries', async () => {
  const g = git(), oldHead = g.head;
  const commit = await commitPackage(args(g));
  assert.notEqual(commit.oid, oldHead);
  assert.equal(g.tree['README.md'], 'untouched');
  for (const a of additions) assert.equal(g.tree[a.path], a.contents);
  assert.equal(g.history.length, 1);
  assert.equal(g.calls, 1);
});
test('competing commits on the same expected head cannot both succeed', async () => {
  const g = git(), first = args(g), second = args(g, { operationId: 'operation_2' });
  const result = await Promise.allSettled([commitPackage(first), commitPackage(second)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(g.history.length, 1);
});
test('same-image replacement race does not overwrite the winner', async () => {
  const g = git(), stale = args(g);
  const replacement = [{ ...additions[2], contents: Buffer.from('new image').toString('base64') }];
  await commitPackage(args(g, { operationId: 'other', additions: replacement }));
  await assert.rejects(commitPackage(stale), { code: 'head_changed' });
  assert.equal(g.tree[replacement[0].path], replacement[0].contents);
});
test('lost response is reconciled without a second mutation, including ancestor success', async () => {
  const g = git();
  await assert.rejects(commitPackage(args(g, { graphql: async req => {
    await g.graphql(req); throw new Error('connection lost');
  } })));
  const saved = g.head;
  await commitPackage(args(g, { operationId: 'later', additions: [{path:'README.md',contents:'bGF0ZXI='}] }));
  const verify = async oid => additions.every(a => g.history.find(c => c.oid === oid).tree[a.path] === a.contents);
  const result = await reconcilePackage({ history: g.history, operationId: 'operation_1', digest, verify, currentHead: g.head });
  assert.deepEqual(result, { state: 'succeeded', commitOid: saved, remoteChanged: true });
  assert.equal(g.calls, 2);
});
test('markers without verified bytes and missing history stay uncertain', async () => {
  const result = await reconcilePackage({ history: [{oid:sha('forged'),message:'heading\n\n'+operationMarker('operation_1',digest)}],
    operationId:'operation_1',digest,verify:async()=>false,currentHead:sha('head') });
  assert.deepEqual(result, {state:'uncertain'});
});
test('protected-branch rejection never triggers a REST fallback or automatic retry', async () => {
  let calls = 0;
  await assert.rejects(commitPackage(args(git(), { graphql: async () => {
    calls++; return {errors:[{type:'FORBIDDEN'}]};
  } })), {code:'protected_branch'});
  assert.equal(calls,1);
});
test('bounded maximum additions are serialized as base64 without per-file commits', async () => {
  const images = Array.from({length:2},(_,i)=>({path:`assets/posts/proof/${i}.png`,contents:Buffer.alloc(4*1024*1024,i).toString('base64')}));
  let size = 0;
  await commitPackage(args(git(), { additions:[...additions.slice(0,2),...images], graphql: async request => {
    size = Buffer.byteLength(JSON.stringify(request));
    return {data:{createCommitOnBranch:{commit:{oid:sha('max')}}}};
  } }));
  assert(size > 8*1024*1024 && size < 12*1024*1024);
});
