import { Fragment, type CSSProperties } from "react";
import {
  address,
  category,
  connectionLabels,
  needsCredential,
  type Category,
  type Connection,
} from "./connection-form.js";
import type { Platform } from "./platform-form.js";
import {
  ConnectionTest,
  ConnectionTestFeedback,
  connectionTestUnavailable,
  type ConnectionTestResult,
} from "./connection-test.js";
import { PencilIcon, ProtocolGlyph, TrashIcon } from "./icons.js";

// "已配置" only means the required local fields are present, never that the
// upstream was probed.
export function connectionStatus(item: Platform | Connection) {
  if (!item.enabled) return "停用";
  const needsSecret =
    "auth" in item ? item.auth.type !== "none" : needsCredential(item);
  if (needsSecret && !item.hasSecret) return "缺密钥";
  if ("rules" in item && !item.rules.length) return "待整理";
  return "已配置";
}

export function matchesConnection(query: string) {
  const text = query.trim().toLocaleLowerCase();
  return (item: Platform | Connection) =>
    !text ||
    [
      item.alias,
      item.note ?? "",
      item.name,
      item.description,
      "baseUrl" in item ? item.baseUrl : address(item),
      "baseUrl" in item ? "API" : connectionLabels[item.kind],
    ].some((value) => value.toLocaleLowerCase().includes(text));
}

export function inCategory(item: Platform | Connection, filter: Category) {
  return (
    filter === "全部" ||
    ("baseUrl" in item ? filter === "API" : category(item.kind) === filter)
  );
}

export function StatusBadge({ item }: { item: Platform | Connection }) {
  const status = connectionStatus(item);
  const tone =
    status === "已配置" ? "ready" : status === "停用" ? "off" : "pending";
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

export function ConnectionList({
  platforms,
  connections,
  filter,
  query,
  actionsDisabled,
  connectionTest,
  onAdd,
  onEditPlatform,
  onEditConnection,
  onRemove,
}: {
  platforms: Platform[];
  connections: Connection[];
  filter: Category;
  query: string;
  actionsDisabled: boolean;
  connectionTest: {
    disabled: boolean;
    pending: string | null;
    result: ConnectionTestResult | null;
    onTest: (connection: Platform | Connection) => void;
    onCancel: () => void;
    onConfirm: (connection: Platform | Connection, model?: string) => void;
  };
  onAdd: () => void;
  onEditPlatform: (platform: Platform) => void;
  onEditConnection: (connection: Connection) => void;
  onRemove: (item: Platform | Connection) => void;
}) {
  const matches = matchesConnection(query);
  const visible: (Platform | Connection)[] = [...platforms, ...connections].filter(
    (item) => inCategory(item, filter) && matches(item),
  );
  if (!platforms.length && !connections.length)
    return (
      <div className="empty-state">
        <div className="empty-mark" aria-hidden="true">
          <ProtocolGlyph kind="api" size="large" />
          <ProtocolGlyph kind="ssh" size="large" />
          <ProtocolGlyph kind="postgres" size="large" />
        </div>
        <h2>暂无连接</h2>
        <p>添加 API、SSH 或数据库连接后，AI 助手就能按手册替你调用，密钥始终留在本机。</p>
        <button className="primary" disabled={actionsDisabled} onClick={onAdd}>
          新建连接
        </button>
      </div>
    );
  return (
    <div className="connection-list" role="table" aria-label="连接列表">
      <div className="connection-list-head" role="row">
        <span role="columnheader">连接</span><span role="columnheader">地址</span>
        <span role="columnheader">配置</span><span role="columnheader">操作</span>
      </div>
      {visible.map((item, index) => {
        const kind = "baseUrl" in item ? "api" : item.kind;
        const label = "baseUrl" in item ? "API" : connectionLabels[item.kind];
        const openEditor = () => {
          if ("baseUrl" in item) onEditPlatform(item);
          else onEditConnection(item);
        };
        return (
          <Fragment key={`${kind}:${item.alias}`}>
          <div
            role="row"
            className="connection-row"
            style={{ "--row": Math.min(index, 12) } as CSSProperties}
            onClick={(event) => {
              // Dragging across the address to copy it ends in a click too.
              if (!actionsDisabled && event.target instanceof Element &&
                !event.target.closest("button, a, input") &&
                !window.getSelection()?.toString()) openEditor();
            }}
          >
            <div role="cell" className="cell-identity">
              <ProtocolGlyph kind={kind} />
              <div className="identity-text">
                <button className="alias-button" disabled={actionsDisabled} onClick={openEditor}>
                  {item.alias}
                </button>
                {item.note ? (
                  <span className="connection-note" title={item.note}>{item.note}</span>
                ) : (
                  <span className="connection-kind">{label}</span>
                )}
              </div>
            </div>
            <div role="cell" className="cell-address">
              <span className="address" title={"baseUrl" in item ? item.baseUrl : address(item)}>
                {"baseUrl" in item ? item.baseUrl : address(item)}
              </span>
            </div>
            <div role="cell" className="cell-status">
              <StatusBadge item={item} />
            </div>
            <div role="cell" className="row-actions">
                <ConnectionTest
                  connection={item}
                  unavailable={connectionTestUnavailable(item)}
                  pending={connectionTest.pending === item.alias}
                  disabled={connectionTest.disabled}
                  result={connectionTest.result}
                  onTest={() => connectionTest.onTest(item)}
                  onCancel={connectionTest.onCancel}
                  onConfirm={() => connectionTest.onConfirm(item)}
                  compact
                />
              <button
                className="icon-button"
                aria-label="编辑"
                title="编辑"
                disabled={actionsDisabled}
                onClick={openEditor}
              >
                <PencilIcon />
              </button>
              <button
                className="icon-button danger"
                aria-label="删除"
                title="删除"
                disabled={actionsDisabled}
                onClick={() => onRemove(item)}
              >
                <TrashIcon />
              </button>
            </div>
          </div>
          {connectionTest.result?.alias === item.alias && connectionTest.result.revision === item.revision && (
            <div role="row" className="connection-row-feedback">
              <div role="cell" aria-colspan={4}>
                <ConnectionTestFeedback connection={item} unavailable={connectionTestUnavailable(item)} result={connectionTest.result}
                  onConfirm={(model) => connectionTest.onConfirm(item, model)} />
              </div>
            </div>
          )}
          </Fragment>
        );
      })}
      {!visible.length && (
        <div role="row" className="connection-row list-empty">
          <div role="cell">{query.trim() ? "没有匹配的连接" : "这个分类还没有连接"}</div>
        </div>
      )}
    </div>
  );
}

export type UnrecognizedRecord = {
  alias: string | null;
  type: "api" | "connection";
  kind: string | null;
};

// Records written by another Abilock version (or damaged) are kept but never
// usable here. The user can delete one explicitly; nothing is auto-repaired.
export function UnrecognizedRecords({
  records,
  disabled,
  onRemove,
}: {
  records: UnrecognizedRecord[];
  disabled: boolean;
  onRemove: (alias: string) => void;
}) {
  if (!records.length) return null;
  return (
    <section className="callout callout-warning unrecognized" role="status" aria-label="无法识别的记录">
      <p>
        以下 {records.length} 条记录无法被当前版本识别，已暂停使用但未删除。可能来自更新的
        Abilock 版本；升级后会恢复。
      </p>
      <ul>
        {records.map((record, index) => (
          <li key={`${record.alias ?? "unnamed"}:${index}`}>
            <span>
              {record.alias ?? "（无效别名）"}
              {record.kind ? ` · ${record.kind}` : record.type === "api" ? " · API" : ""}
            </span>
            {record.alias && (
              <button
                type="button"
                className="small"
                disabled={disabled}
                onClick={() => onRemove(record.alias!)}
              >
                删除
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
