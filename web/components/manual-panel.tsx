import { address, connectionLabels, type Connection } from "./connection-form.js";
import { StatusBadge } from "./connection-list.js";
import { BackIcon, PencilIcon, ProtocolGlyph } from "./icons.js";
import { Manual, publicDocUrl } from "./manual.js";
import { ManualHistory, type SavedManual } from "./manual-edit.js";
import type { Platform } from "./platform-form.js";

export function ManualPanel({
  alias,
  owner,
  manuals,
  guide,
  stale,
  busy,
  configurationReady,
  onEditOwner,
  onEditManual,
  onBack,
}: {
  alias: string;
  owner: Platform | Connection | undefined;
  manuals: SavedManual[];
  guide: { title: string; markdown: string } | undefined;
  stale: boolean;
  busy: boolean;
  configurationReady: boolean;
  onEditOwner: (owner: Platform | Connection) => void;
  onEditManual: (manual: SavedManual) => void;
  onBack: () => void;
}) {
  const source = publicDocUrl(owner?.documentationUrl);
  return (
    <div className="manual-panel">
      <button className="back-button" onClick={onBack}>
        <BackIcon />
        返回
      </button>
      <div className="manual-hero">
        {owner && <ProtocolGlyph kind={"baseUrl" in owner ? "api" : owner.kind} size="large" />}
        <div className="manual-title">
          <h1>{alias}</h1>
          <p className="manual-subtitle">
            {owner ? ("baseUrl" in owner ? "API" : connectionLabels[owner.kind]) : ""} 手册
          </p>
        </div>
        {owner && (
          <button disabled={busy || !configurationReady} onClick={() => onEditOwner(owner)}>
            <PencilIcon />
            编辑连接
          </button>
        )}
      </div>
      {owner && (
        <dl className="connection-summary">
          <div><dt>备注</dt><dd>{owner.note || "—"}</dd></div>
          <div><dt>类型</dt><dd>{"baseUrl" in owner ? "API" : connectionLabels[owner.kind]}</dd></div>
          <div className="summary-address"><dt>地址</dt><dd>{"baseUrl" in owner ? owner.baseUrl : address(owner)}</dd></div>
          <div><dt>状态</dt><dd><StatusBadge item={owner} /></dd></div>
        </dl>
      )}
      {source && (
        <div className="source-row">
          <a className="source-link" href={source} target="_blank" rel="noopener noreferrer">官方文档 ↗</a>
          <input aria-label="官方文档地址" readOnly value={source} onFocus={(event) => event.target.select()} />
        </div>
      )}
      {stale && (
        <p className="manual-update" role="status">
          连接或文档已变更，手册待更新
        </p>
      )}
      {!owner ? (
        <p className="empty">连接已删除</p>
      ) : !manuals.length && !guide ? (
        <div className="manual-empty">
          <h2>待学习</h2>
          <p>
            {source
              ? "让 AI 助手读取已填文档，保存用法。"
              : "编辑连接，填写 API 文档链接，再让 AI 助手整理。"}
          </p>
        </div>
      ) : (
        <>
          {manuals.map((doc) => (
            <section className="manual-document" key={doc.id}>
              <div className="manual-document-heading">
                <div>
                  <h2>{doc.title}</h2>
                  {doc.updatedAt && (
                    <small className="manual-updated">更新于 {new Date(doc.updatedAt).toLocaleString()}</small>
                  )}
                </div>
                <div className="actions">
                  <button type="button" disabled={busy} aria-label={`编辑 ${doc.title}`} onClick={() => onEditManual(doc)}>
                    编辑
                  </button>
                  {publicDocUrl(doc.sourceUrl) && (
                    <a href={publicDocUrl(doc.sourceUrl)!} target="_blank" rel="noopener noreferrer">
                      来源 ↗
                    </a>
                  )}
                </div>
              </div>
              <Manual markdown={doc.markdown} />
              <ManualHistory previous={doc.previous} />
            </section>
          ))}
          {guide && (
            <section className="manual-document">
              <div className="manual-document-heading">
                <h2>{manuals.length ? "命令" : guide.title}</h2>
                <small>内置</small>
              </div>
              <Manual markdown={guide.markdown} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
