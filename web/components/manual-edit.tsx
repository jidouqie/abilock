import React from "react";
import { Manual, publicDocUrl } from "./manual.js";
import { FieldLabel } from "./field-label.js";

export type ManualVersion = {
  title: string;
  sourceUrl: string;
  markdown: string;
  revision: number;
  updatedAt: string;
};
export type SavedManual = {
  id: string;
  alias: string;
  title: string;
  sourceUrl: string;
  markdown: string;
  revision: number;
  updatedAt?: string;
  previous?: ManualVersion;
};
export type ManualDraft = Pick<SavedManual, "id" | "title" | "sourceUrl" | "markdown" | "revision" | "previous">;
export function manualDraft(doc: SavedManual): ManualDraft {
  return { id: doc.id, title: doc.title, sourceUrl: doc.sourceUrl,
    markdown: doc.markdown, revision: doc.revision,
    ...(doc.previous ? { previous: { ...doc.previous } } : {}) };
}
export function previousManualDraft(draft: ManualDraft): ManualDraft {
  if (!draft.previous) return draft;
  // Loading a previous body never changes the current identity, source or
  // optimistic version. The user reviews and saves through the ordinary form.
  return { ...draft, title: draft.previous.title, markdown: draft.previous.markdown };
}
export function continueManualDraft(draft: ManualDraft, latest: SavedManual): ManualDraft {
  if (latest.id !== draft.id || !Number.isSafeInteger(latest.revision) ||
    latest.revision < draft.revision)
    throw new Error("手册版本无效，请重新读取");
  // The user reviews the current saved body before accepting its revision.
  // Keep their unsaved text; this does not submit or silently merge a save.
  return { ...manualDraft(latest), title: draft.title, markdown: draft.markdown };
}
export function ManualHistory({ previous }: { previous?: ManualVersion }) {
  if (!previous) return null;
  const source = publicDocUrl(previous.sourceUrl);
  return <details className="manual-history">
    <summary>上一版</summary>
    <div className="manual-history-meta">
      <span>版本 {previous.revision} · {new Date(previous.updatedAt).toLocaleString()}</span>
      {source && <a href={source} target="_blank" rel="noopener noreferrer">来源 ↗</a>}
    </div>
    <h3>{previous.title}</h3>
    <Manual markdown={previous.markdown} />
  </details>;
}
export function manualWrite(draft: ManualDraft) {
  if (!draft.title.trim() || !draft.markdown.trim())
    throw new Error("请填写标题和正文");
  if (!Number.isSafeInteger(draft.revision) || draft.revision < 1)
    throw new Error("手册版本无效，请重新打开");
  return {
    doc: { title: draft.title, sourceUrl: draft.sourceUrl, markdown: draft.markdown },
    expectedRevision: draft.revision,
  };
}
export function ManualEditor({ draft, onChange, onSubmit, busy, error,
  latest, onLoadLatest, loadingLatest = false }: {
  draft: ManualDraft;
  onChange: (value: ManualDraft) => void;
  onSubmit: (event: React.FormEvent) => void;
  busy: boolean;
  error?: string;
  latest?: SavedManual | null;
  onLoadLatest?: () => void;
  loadingLatest?: boolean;
}) {
  const source = publicDocUrl(draft.sourceUrl);
  const current = latest?.id === draft.id ? latest : undefined;
  const canContinue = !!current && current.revision > draft.revision;
  return <form className="manual-editor" onSubmit={onSubmit}>
    <fieldset disabled={busy}>
      <label><FieldLabel required>标题</FieldLabel><input aria-label="标题" value={draft.title} required maxLength={200}
        onChange={(event) => onChange({ ...draft, title: event.target.value })} /></label>
      {source && <a className="manual-editor-source" href={source} target="_blank" rel="noopener noreferrer">来源 ↗</a>}
      {draft.previous && <div className="manual-history-actions">
        <button type="button" onClick={() => onChange(previousManualDraft(draft))}>用上一版填入草稿</button>
      </div>}
      <label><FieldLabel required>正文</FieldLabel><textarea aria-label="正文" value={draft.markdown} required maxLength={2_000_000} rows={18}
        onChange={(event) => onChange({ ...draft, markdown: event.target.value })} /></label>
      {onLoadLatest && <section className="manual-latest" aria-label="核对最新手册">
        <div className="manual-document-heading">
          <h3>最新手册</h3>
          <button type="button" disabled={loadingLatest} onClick={onLoadLatest}>
            {loadingLatest ? "读取中…" : "查看最新"}
          </button>
        </div>
        {latest === null ? <p className="error" role="status">手册已删除，草稿仍在上方，无法继续保存。</p>
          : current ? <>
            <p className="manual-history-meta" role="status">
              {current.revision < draft.revision ? "读取结果已过期，请重新读取。"
                : current.revision === draft.revision ? "草稿基于此版本。"
                  : "已读取最新内容，你的草稿未变。"}
            </p>
            <h4>{current.title}</h4>
            {publicDocUrl(current.sourceUrl) && <p className="manual-editor-source">来源：{current.sourceUrl}</p>}
            <Manual markdown={current.markdown} />
            {canContinue && <div className="manual-history-actions">
              <p>核对后继续编辑，保留上方标题和正文。保存时仍会检查是否有新修改。</p>
              <button type="button" onClick={() => onChange(continueManualDraft(draft, current))}>
                以此版本继续编辑
              </button>
            </div>}
          </> : <p>读取已保存的内容，不替换草稿。</p>}
      </section>}
      <ManualHistory previous={draft.previous} />
      {error && <div className="error" role="alert">{error}</div>}
      <div className="form-actions"><button className="primary" type="submit" disabled={loadingLatest || latest === null}>{busy ? "保存中…" : "保存"}</button></div>
    </fieldset>
  </form>;
}
