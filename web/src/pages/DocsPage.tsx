import { Link, NavLink, useParams } from 'react-router-dom';
import { getDoc, listDocs } from '../api';
import { Markdown } from '../components/Markdown';
import { EmptyState, ErrorState, Loading, PageHead } from '../components/StateView';
import { useAsync } from '../hooks';
import type { DocContent, DocSummary } from '../types';

export function DocsPage() {
  const { name } = useParams<{ name?: string }>();
  const {
    data: docListData,
    loading: listLoading,
    error: listError,
    reload: reloadList,
  } = useAsync<DocSummary[]>(async () => {
    const response = await listDocs();
    return response.data;
  }, []);
  const {
    data: doc,
    loading: docLoading,
    error: docError,
    reload: reloadDoc,
  } = useAsync<DocContent | null>(async () => name ? getDoc(name) : null, [name]);
  const docs = docListData || [];

  return (
    <div className="docs-page">
      <PageHead
        eyebrow="SERPENT 文档"
        title="赛场文档"
        description="查阅游戏规则、脚本接口、MCP 接入、REST API 与天梯说明。"
        actions={<Link className="btn ghost" to="/docs/mcp">接入指南 ↗</Link>}
      />

      <div className="docs-layout">
        <aside className="docs-sidebar" aria-label="文档目录">
          <div className="docs-sidebar-title">
            <h2>文档目录</h2>
            <Link to="/docs">文档首页</Link>
          </div>
          {listLoading && !docListData ? (
            <Loading label="正在读取文档目录…" />
          ) : listError && !docListData ? (
            <ErrorState message={listError} onRetry={reloadList} />
          ) : docs.length === 0 ? (
            <EmptyState title="暂时没有文档目录" />
          ) : (
            <nav className="docs-nav">
              {docs.map((item) => (
                <NavLink
                  className={({ isActive }) => isActive ? 'doc-nav-link active' : 'doc-nav-link'}
                  to={`/docs/${encodeURIComponent(item.name)}`}
                  key={item.name}
                >
                  <span>{item.title}</span>
                  {item.description && <small>{item.description}</small>}
                </NavLink>
              ))}
            </nav>
          )}
          {listError && docListData && <p className="error-message" role="alert">{listError}</p>}
        </aside>

        <main className="docs-content">
          {!name ? (
            <section className="docs-index" aria-labelledby="docs-index-title">
              <div className="section-heading">
                <div>
                  <div className="eyebrow">从这里开始</div>
                  <h2 id="docs-index-title">先懂规则，再让代码上场</h2>
                  <p>选择左侧文档，或从下面的主题进入。所有文档均可直接分享链接。</p>
                </div>
              </div>
              {listLoading && !docListData ? (
                <Loading label="正在准备文档…" />
              ) : docs.length === 0 ? (
                listError ? <ErrorState message={listError} onRetry={reloadList} /> : <EmptyState title="暂无可用文档" />
              ) : (
                <div className="docs-card-grid">
                  {docs.map((item) => (
                    <Link className="docs-card" to={`/docs/${encodeURIComponent(item.name)}`} key={item.name}>
                      <span className="docs-card-name">{item.name}</span>
                      <h3>{item.title}</h3>
                      <p>{item.description || '打开文档查看详细说明。'}</p>
                      <span className="text-link">开始阅读 →</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          ) : docLoading ? (
            <Loading label="正在加载文档…" />
          ) : docError ? (
            <ErrorState message={docError} onRetry={reloadDoc} />
          ) : !doc || doc.name !== name ? (
            <EmptyState title="没有找到这篇文档">
              <Link className="btn ghost small" to="/docs">返回文档首页</Link>
            </EmptyState>
          ) : (
            <article className="docs-article">
              <header className="docs-article-head">
                <Link className="text-link" to="/docs">← 全部文档</Link>
                <h1>{doc.title}</h1>
                {docs.find((item) => item.name === doc.name)?.description && (
                  <p>{docs.find((item) => item.name === doc.name)?.description}</p>
                )}
              </header>
              {(doc.markdown || doc.content || '').trim() ? (
                <Markdown markdown={doc.markdown || doc.content || ''} />
              ) : (
                <EmptyState title="这篇文档暂无内容" />
              )}
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
