/**
 * 查找对同一完整 Git tree 执行成功的本仓 PR CI。
 * artifact 只作索引；来源 workflow 整体成功后才有效，不下载或执行其中的内容。
 * 返回来源运行 URL，未命中返回空串；API 错误交由调用方显式回退到正常检查。
 */
async function findSuccessfulRun(github, context, tree) {
  const name = `ci-pass-v1-${tree}`;
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...context.repo,
    name,
    per_page: 100,
  });
  if (artifacts.length === 0) return '';

  const { data: workflow } = await github.rest.actions.getWorkflow({
    ...context.repo,
    workflow_id: 'ci.yml',
  });
  const repositoryId = context.payload.repository.id;
  for (const artifact of artifacts) {
    const source = artifact.workflow_run;
    if (artifact.name !== name || artifact.expired || !source
      || source.id === context.runId || source.head_repository_id !== repositoryId) continue;

    const { data: run } = await github.rest.actions.getWorkflowRun({
      ...context.repo,
      run_id: source.id,
    });
    if (run.workflow_id === workflow.id && run.event === 'pull_request'
      && run.status === 'completed' && run.conclusion === 'success'
      && run.head_repository?.id === repositoryId) return run.html_url;
  }
  return '';
}

module.exports = { findSuccessfulRun };
