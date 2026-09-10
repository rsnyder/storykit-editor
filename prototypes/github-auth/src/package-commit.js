/** M0 expected-head primitive. The caller owns authentication, path/content
 * validation, leases and durable attempt metadata; this is not a public proxy.
 * No REST read/update-ref fallback: only GitHub enforces the head precondition.
 */
const COMMIT = `mutation StoryKitPackageCommit($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid url } }
}`;
const OID = /^[a-f0-9]{40}$/;
const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function operationMarker(operationId, digest) {
  if (!ID.test(operationId) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid operation identity.');
  return `StoryKit-Operation: ${operationId}\nStoryKit-Package: ${digest}`;
}

export async function commitPackage({ graphql, repository, branch, expectedHead, operationId, digest, additions }) {
  if (!OID.test(expectedHead) || !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      typeof branch !== 'string' || !branch || branch.length > 255) throw new Error('Invalid commit destination.');
  if (!Array.isArray(additions) || !additions.length || additions.length > 52) throw new Error('Invalid package additions.');
  const marker = operationMarker(operationId, digest);
  const result = await graphql({ query: COMMIT, variables: { input: {
    branch: { repositoryNameWithOwner: repository, branchName: branch },
    expectedHeadOid: expectedHead,
    message: { headline: 'Save story package from StoryKit', body: marker },
    fileChanges: { additions: additions.map(({ path, contents }) => ({ path, contents })) },
  } } });
  // Transport exceptions and ambiguous payloads have uncertain outcomes. Never
  // retry here, and never interpret clientMutationId as an idempotency key.
  const rejected = result.errors?.find(e => ['STALE_DATA', 'FORBIDDEN'].includes(e.type) && (!e.path || e.path.length === 1));
  if (rejected) { const error = new Error(rejected.type === 'STALE_DATA' ? 'The branch advanced during the save.' : 'GitHub branch protection or permissions rejected the package.'); error.code = rejected.type === 'STALE_DATA' ? 'head_changed' : 'protected_branch'; error.status = rejected.type === 'STALE_DATA' ? 409 : 403; throw error; }
  if (result.errors?.length || !OID.test(result.data?.createCommitOnBranch?.commit?.oid)) {
    const error = new Error('Package commit not confirmed. Reconcile this operation before retrying.');
    error.code = 'uncertain';
    throw error;
  }
  return result.data.createCommitOnBranch.commit;
}

/** History is bounded by the caller. A marker alone is not evidence: verify
 * all package path/blob identities at that commit before recording success.
 * An ancestor success must not be mislabeled as the current remote state.
 */
export async function reconcilePackage({ history, operationId, digest, verify, currentHead }) {
  const marker = operationMarker(operationId, digest);
  for (const commit of history.slice(0, 100)) {
    if (!OID.test(commit.oid) || typeof commit.message !== 'string') continue;
    if (commit.message.split('\n\n').includes(marker) && await verify(commit.oid)) {
      return { state: 'succeeded', commitOid: commit.oid, remoteChanged: commit.oid !== currentHead };
    }
  }
  return { state: 'uncertain' };
}
