import * as queries from '../../db/queries.js';

export async function listTemplatesHandler(): Promise<string> {
  const templates = queries.listTemplates();
  const summaries = templates.map(t => ({
    id: t.id,
    name: t.name,
    model: t.model,
    is_readonly: !!t.is_readonly,
    has_repo: !!t.repo_id,
    has_project: !!t.project_id,
    retry_policy: t.retry_policy !== 'none' ? t.retry_policy : undefined,
    content_preview: t.content.slice(0, 150) + (t.content.length > 150 ? '…' : ''),
  }));
  return JSON.stringify({ templates: summaries });
}
