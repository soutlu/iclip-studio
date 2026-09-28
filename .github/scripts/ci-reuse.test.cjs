const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findSuccessfulRun } = require('./ci-reuse.cjs');

const tree = 'a'.repeat(40);
const context = {
  repo: { owner: 'owner', repo: 'repo' },
  runId: 10,
  payload: { repository: { id: 1 } },
};
const artifact = {
  name: `ci-pass-v1-${tree}`,
  expired: false,
  workflow_run: { id: 9, head_repository_id: 1 },
};
const run = {
  id: 9,
  workflow_id: 2,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'success',
  head_repository: { id: 1 },
  html_url: 'https://github.com/owner/repo/actions/runs/9',
};

function client(artifacts = [artifact], runs = { 9: run }) {
  return {
    rest: {
      actions: {
        getWorkflow: async ({ workflow_id }) => {
          assert.equal(workflow_id, 'ci.yml');
          return { data: { id: 2 } };
        },
        listArtifactsForRepo: () => {},
        getWorkflowRun: async ({ run_id }) => ({ data: runs[run_id] }),
      },
    },
    paginate: async (_method, args) => {
      assert.equal(args.name, `ci-pass-v1-${tree}`);
      return artifacts;
    },
  };
}

test('相同文件树可跨提交复用成功的 PR 检查', async () => {
  assert.equal(await findSuccessfulRun(client(), context, tree), run.html_url);
});

test('没有完整文件树的证明时正常检查', async () => {
  assert.equal(await findSuccessfulRun(client([]), context, tree), '');
});

for (const [name, change] of [
  ['不同文件树', { name: `ci-pass-v1-${'b'.repeat(40)}` }],
  ['已过期', { expired: true }],
  ['当前运行', { workflow_run: { id: 10, head_repository_id: 1 } }],
  ['fork', { workflow_run: { id: 9, head_repository_id: 3 } }],
  ['无来源运行', { workflow_run: null }],
]) {
  test(`不复用${name}的证明`, async () => {
    const github = client([{ ...artifact, ...change }]);
    assert.equal(await findSuccessfulRun(github, context, tree), '');
  });
}

for (const [name, change] of [
  ['其他工作流', { workflow_id: 3 }],
  ['失败', { conclusion: 'failure' }],
  ['取消', { conclusion: 'cancelled' }],
  ['尚未完成', { status: 'in_progress' }],
  ['非 PR', { event: 'workflow_dispatch' }],
  ['fork', { head_repository: { id: 3 } }],
]) {
  test(`不复用${name}的运行`, async () => {
    const github = client([artifact], { 9: { ...run, ...change } });
    assert.equal(await findSuccessfulRun(github, context, tree), '');
  });
}

test('同树的最近运行失败时仍可使用更早的成功结果', async () => {
  const github = client(
    [artifact, { ...artifact, workflow_run: { id: 8, head_repository_id: 1 } }],
    { 9: { ...run, conclusion: 'failure' }, 8: { ...run, id: 8 } },
  );
  assert.equal(await findSuccessfulRun(github, context, tree), run.html_url);
});

test('API 失败向调用方报告，不能当作命中', async () => {
  const github = client();
  github.paginate = async () => { throw new Error('API unavailable'); };
  await assert.rejects(findSuccessfulRun(github, context, tree), /API unavailable/);
});
