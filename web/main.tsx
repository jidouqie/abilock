import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import {
  blankConnection,
  categoryLabels,
  connectionWrite,
  type Category,
  type Connection,
  type ConnectionKind,
} from "./components/connection-form.js";
import { ManualEditor, manualDraft, manualWrite, type ManualDraft, type SavedManual } from "./components/manual-edit.js";
import { validPasswordLength } from "../src/password-policy.js";
import { connectionTestError, connectionTestUnavailable, readConnectionTestPlan, type ConnectionTestResult, type TestableConnection } from "./components/connection-test.js";
import { blankPlatform, platformWrite, type Platform } from "./components/platform-form.js";
import {
  configurationRestartMessage,
  isConfigurationCompatible,
  requireConfigurationCompatible,
} from "../src/configuration-contract.js";
import { apiFailure, readJson } from "./admin-api.js";
import { Modal } from "./components/modal.js";
import {
  ConnectionList,
  UnrecognizedRecords,
  inCategory,
  matchesConnection,
  type UnrecognizedRecord,
} from "./components/connection-list.js";
import {
  CategoryIcon,
  KeyIcon,
  LogoutIcon,
  PlusIcon,
  ProtocolGlyph,
  RefreshIcon,
  SearchIcon,
} from "./components/icons.js";
import { ManualPanel } from "./components/manual-panel.js";
import { PlatformEditor } from "./components/platform-editor.js";
import { ConnectionEditor } from "./components/connection-editor.js";
import { Brand, LoginView, PasswordDialog } from "./components/auth-forms.js";
// The macOS app draws this page under its title bar and names itself in the
// user agent. That is layout information only; it grants nothing.
if (/\bAbilockDesktop\b/.test(navigator.userAgent))
  document.documentElement.classList.add("shell-mac");
type SavedDoc = SavedManual;
type ProtocolGuide = {
  alias: string;
  kind: ConnectionKind;
  title: string;
  source: "builtin";
};
type AuthState = {
  initialized: boolean;
  legacy: boolean;
  authenticated: boolean;
  csrfToken?: string;
};
function App() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [logged, setLogged] = useState(false);
  const [csrf, setCsrf] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [passwordEdit, setPasswordEdit] = useState(false);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [unrecognized, setUnrecognized] = useState<UnrecognizedRecord[]>([]);
  const [adapters, setAdapters] = useState<string[]>([]);
  const [formVersion, setFormVersion] = useState<unknown>();
  const [docs, setDocs] = useState<SavedDoc[]>([]);
  const [manualEdit, setManualEdit] = useState<ManualDraft | null>(null);
  const [manualLatest, setManualLatest] = useState<SavedDoc | null | undefined>();
  const [loadingLatest, setLoadingLatest] = useState(false);
  const manualGeneration = useRef(0);
  const [search, setSearch] = useState("");
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [keyReading, setKeyReading] = useState(false);
  const loadGeneration = useRef(0);
  const refreshInFlight = useRef(false);
  const loadedRevision = useRef<string | null>(null);
  const [protocolGuides, setProtocolGuides] = useState<ProtocolGuide[]>([]);
  const [guideMarkdown, setGuideMarkdown] = useState<Record<string, string>>({});
  const [documentationStatuses, setDocumentationStatuses] = useState<Record<string, string>>({});
  const [exportWarning, setExportWarning] = useState("");
  const [selectedManual, setSelectedManual] = useState<string | null>(null);
  const [filter, setFilter] = useState<Category>("全部");
  const [edit, setEdit] = useState<Platform | null>(null);
  const [original, setOriginal] = useState<Platform | null>(null);
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [connectionEdit, setConnectionEdit] = useState<Connection | null>(null);
  const [connectionOriginal, setConnectionOriginal] =
    useState<Connection | null>(null);
  const [sshIdentity, setSshIdentity] = useState("password");
  const [connectionSecrets, setConnectionSecrets] = useState<
    Record<string, string>
  >({});
  const [connectionTestResult, setConnectionTestResult] = useState<ConnectionTestResult | null>(null);
  const [connectionTestPending, setConnectionTestPending] = useState<string | null>(null);
  const connectionTestGeneration = useRef(0);
  const connectionTestInFlight = useRef(false);
  const connectionTestController = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pageInvocationId = useRef<string | null>(null);
  if (pageInvocationId.current === null)
    pageInvocationId.current = crypto.randomUUID();
  function clearConnectionTest() {
    connectionTestGeneration.current++;
    connectionTestController.current?.abort();
    connectionTestController.current = null;
    connectionTestInFlight.current = false;
    setConnectionTestPending(null);
    setConnectionTestResult(null);
  }
  function cancelConnectionTest() {
    connectionTestGeneration.current++;
    connectionTestController.current?.abort();
    connectionTestController.current = null;
    connectionTestInFlight.current = false;
    setConnectionTestPending(null);
    setConnectionTestResult((current) => current ? {
      ...current, status: "cancelled", message: "连接测试已取消，未自动重试" +
        (current.plan?.generation ? "。服务商已受理的请求仍可能计费。" : ""),
    } : null);
  }
  // An error raised inside a dialog belongs to that dialog: closing it must
  // not leave the message on the page behind.
  function closeEdit() {
    clearConnectionTest();
    if (edit) setError("");
    setEdit(null);
    setOriginal(null);
    setSecret("");
    setUsername("");
  }
  function closeConnection() {
    clearConnectionTest();
    if (connectionEdit) setError("");
    setConnectionEdit(null);
    setConnectionOriginal(null);
    setSshIdentity("password");
    setConnectionSecrets({});
  }
  function clearSession() {
    clearConnectionTest();
    loadGeneration.current++;
    loadedRevision.current = null;
    setManualEdit(null);
    setManualLatest(undefined);
    manualGeneration.current++;
    setLoadingLatest(false);
    setSearch("");
    setLastSynced(null);
    setRefreshError("");
    setCsrf("");
    setLogged(false);
    setPlatforms([]);
    setConnections([]);
    setUnrecognized([]);
    setAdapters([]);
    setFormVersion(undefined);
    setDocs([]);
    setProtocolGuides([]);
    setGuideMarkdown({});
    setDocumentationStatuses({});
    setExportWarning("");
    setSelectedManual(null);
    setPassword("");
    setConfirmation("");
    setCurrentPassword("");
    setPasswordEdit(false);
    setNotice("");
    closeEdit();
    closeConnection();
  }
  // Background polls are marked so they never extend the session's idle limit.
  async function api(
    route: string,
    method = "GET",
    value?: unknown,
    token = csrf,
    signal?: AbortSignal,
    background = false,
  ) {
    const response = await fetch(route, {
      method,
      credentials: "same-origin",
      headers: {
        "x-abilock-csrf": token,
        "x-abilock-ui": "1",
        "x-abilock-invocation-id": pageInvocationId.current!,
        ...(background ? { "x-abilock-background": "1" } : {}),
        ...(value !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: value !== undefined ? JSON.stringify(value) : undefined,
      signal,
    });
    const data = await readJson(response);
    if (
      response.status === 401 &&
      !["CONNECTION_TEST_AUTH", "SSH_TEST_AUTH"].includes(data.error?.code) &&
      (!route.startsWith("/admin/auth/") || route === "/admin/auth/logout")
    ) {
      clearSession();
      throw apiFailure(response, data);
    }
    if (!response.ok) throw apiFailure(response, data);
    return data;
  }
  async function load(token = csrf, accept = () => true, background = false) {
    clearConnectionTest();
    const generation = ++loadGeneration.current;
    // Read the revision first: a change that lands while the lists load makes
    // the next poll see a new revision and reload, so the page never sticks.
    const revision = await api("/admin/state-revision", "GET", undefined, token, undefined, background);
    const [p, c, d] = await Promise.all([
      api("/admin/platforms", "GET", undefined, token, undefined, background),
      api("/admin/connections", "GET", undefined, token, undefined, background),
      api("/admin/docs", "GET", undefined, token, undefined, background),
    ]);
    if (generation !== loadGeneration.current || !accept()) return;
    loadedRevision.current = revision.revision;
    setLastSynced(new Date());
    setRefreshError("");
    setPlatforms(p.platforms);
    setFormVersion(p.formVersion);
    setAdapters(p.adapters ?? []);
    setConnections(c.connections);
    setUnrecognized(c.unrecognized ?? []);
    setDocs(d.docs ?? []);
    setProtocolGuides(d.protocolGuides ?? []);
    setGuideMarkdown(d.guideMarkdown ?? {});
    setDocumentationStatuses(d.documentationStatuses ?? {});
    setExportWarning(d.docsExportStatus?.status === "pending"
      ? "已保存，Markdown 副本待重建；下次打开配置页或保存时自动重试。" : "");
  }
  async function refreshStatus() {
    const result: AuthState = await api("/admin/auth/status");
    setAuthState(result);
    return result;
  }
  useEffect(() => {
    void refreshStatus()
      .then(async (result) => {
        if (result.authenticated && result.csrfToken) {
          setCsrf(result.csrfToken);
          await load(result.csrfToken);
          setLogged(true);
        }
      })
      .catch((failure) => setError((failure as Error).message));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    clearConnectionTest();
  }, [connectionEdit, connectionSecrets, sshIdentity, selectedManual, edit, secret, username, manualEdit, passwordEdit, filter, search]);
  useEffect(() => () => { connectionTestController.current?.abort(); }, []);
  const refreshPaused = busy || !!connectionTestPending || !!edit || !!connectionEdit || !!manualEdit || passwordEdit;
  useEffect(() => {
    if (!logged || refreshPaused) return;
    let active = true;
    // An idle page only asks whether anything changed; the full lists and
    // manuals reload when the authoritative state actually moved.
    const refresh = async () => {
      if (!active || refreshInFlight.current || document.visibilityState !== "visible") return;
      refreshInFlight.current = true;
      try {
        const { revision } = await api("/admin/state-revision", "GET", undefined, csrf, undefined, true);
        if (!active) return;
        if (revision !== loadedRevision.current) await load(csrf, () => active, true);
        else {
          setLastSynced(new Date());
          setRefreshError("");
        }
      }
      catch { if (active) setRefreshError("刷新失败，当前显示上次数据"); }
      finally { refreshInFlight.current = false; }
    };
    const onVisible = () => { void refresh(); };
    const timer = window.setInterval(onVisible, 15000);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [logged, csrf, refreshPaused]);
  async function refreshNow() {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try { await load(); }
    catch { setRefreshError("刷新失败，当前显示上次数据"); }
    finally { refreshInFlight.current = false; setRefreshing(false); }
  }
  async function refreshAfterWrite(message: string) {
    setNotice(message);
    try { await load(); return true; }
    catch { setRefreshError(`${message}，刷新失败，请刷新`); return false; }
  }
  function beginManual(doc: SavedDoc) {
    manualGeneration.current++;
    setManualLatest(undefined);
    setLoadingLatest(false);
    setError("");
    setManualEdit(manualDraft(doc));
  }
  function closeManual() {
    if (manualEdit) {
      const saved = docs.find((doc) => doc.id === manualEdit.id);
      if ((manualEdit.title !== saved?.title || manualEdit.markdown !== saved?.markdown) &&
          !confirm("放弃未保存的手册修改？")) return;
    }
    manualGeneration.current++;
    setManualEdit(null);
    setManualLatest(undefined);
    setLoadingLatest(false);
    setError("");
  }
  async function loadLatestManual() {
    if (!manualEdit) return;
    const generation = ++manualGeneration.current;
    const id = manualEdit.id;
    setLoadingLatest(true);
    try {
      const data = await api("/admin/docs");
      if (generation !== manualGeneration.current) return;
      setManualLatest(data.docs.find((doc: SavedDoc) => doc.id === id) ?? null);
    } catch (failure) {
      if (generation === manualGeneration.current) setError((failure as Error).message);
    } finally {
      if (generation === manualGeneration.current) setLoadingLatest(false);
    }
  }
  async function saveManual(event: React.FormEvent) {
    event.preventDefault();
    if (!manualEdit) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/docs/${encodeURIComponent(manualEdit.id)}`, "PUT", manualWrite(manualEdit));
      manualGeneration.current++;
      setManualEdit(null);
      setManualLatest(undefined);
      await refreshAfterWrite("已保存");
    } catch (failure) {
      const problem = failure as Error & { code?: string };
      setError(problem.code === "REVISION_CONFLICT"
        ? "手册已变化，草稿已保留。请核对最新版本后再修改。" : problem.message);
    } finally { setBusy(false); }
  }
  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!authState?.legacy && !validPasswordLength(password)) {
      setError("密码须为 8–256 个字符");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const initial = !authState?.initialized && !authState?.legacy;
      const result = await api(
        initial ? "/admin/auth/setup" : "/admin/auth/login",
        "POST",
        {
          password,
          ...(initial ? { confirmPassword: confirmation } : {}),
        },
      );
      setPassword("");
      setConfirmation("");
      setCsrf(result.csrfToken);
      await load(result.csrfToken);
      await refreshStatus();
      setLogged(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPassword("");
      setConfirmation("");
      setBusy(false);
    }
  }
  async function logout() {
    clearConnectionTest();
    setBusy(true);
    setError("");
    try {
      await api("/admin/auth/logout", "POST");
      clearSession();
      await refreshStatus();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function closePassword() {
    setError("");
    setPasswordEdit(false);
    setPassword("");
    setConfirmation("");
    setCurrentPassword("");
  }
  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!validPasswordLength(password)) {
      setError("密码须为 8–256 个字符");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const migrating = !authState?.initialized;
      const result = await api(
        migrating ? "/admin/auth/setup" : "/admin/auth/password",
        "POST",
        {
          password,
          confirmPassword: confirmation,
          ...(!migrating ? { currentPassword } : {}),
        },
      );
      setCsrf(result.csrfToken);
      setPasswordEdit(false);
      await refreshStatus();
      setNotice("已保存");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPassword("");
      setConfirmation("");
      setCurrentPassword("");
      setBusy(false);
    }
  }
  function beginEdit(platform?: Platform) {
    setError("");
    setOriginal(platform ? structuredClone(platform) : null);
    setEdit(structuredClone(platform ?? blankPlatform));
    setSecret("");
    setUsername("");
  }
  function changeAuth(auth: Platform["auth"]) {
    if (!edit) return;
    setEdit({ ...edit, auth });
    setSecret("");
    setUsername("");
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!edit) return;
    setBusy(true);
    setError("");
    try {
      requireConfigurationCompatible(formVersion);
      const input = platformWrite(edit, original, { secret, username });
      await api(
        `/admin/platforms/${encodeURIComponent(original?.alias ?? input.platform.alias)}`,
        "PUT",
        input,
      );
      closeEdit();
      const refreshed = await refreshAfterWrite("已保存");
      if (original?.alias === selectedManual) setSelectedManual(refreshed ? input.platform.alias : null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSecret("");
      setUsername("");
      setBusy(false);
    }
  }
  function beginAdd(kind: ConnectionKind | "api" = "api") {
    closeEdit();
    closeConnection();
    setError("");
    if (kind === "api") beginEdit();
    else setConnectionEdit(blankConnection(kind));
  }
  function beginConnection(connection: Connection) {
    setConnectionEdit(structuredClone(connection));
    setConnectionOriginal(structuredClone(connection));
    setSshIdentity(connection.hasSecret ? "keep" : "password");
    setConnectionSecrets({});
    setError("");
  }
  function changeConnection(connection: Connection) {
    if (
      connectionEdit &&
      (connection.config.auth !== connectionEdit.config.auth ||
        connection.config.authType !== connectionEdit.config.authType ||
        connection.config.transport !== connectionEdit.config.transport)
    )
      setConnectionSecrets({});
    setConnectionEdit(connection);
  }
  async function testSavedConnection(saved: TestableConnection, fromEditor = false, allowBillable = false, model?: string) {
    if (busy || keyReading || refreshing || connectionTestInFlight.current || !isConfigurationCompatible(formVersion)) return;
    if (allowBillable && (connectionTestResult?.status !== "confirmation" ||
      connectionTestResult.alias !== saved.alias || connectionTestResult.revision !== saved.revision ||
      connectionTestResult.plan?.billing !== "possible")) return;
    if (allowBillable && connectionTestResult?.plan?.generation &&
      !connectionTestResult.plan.generation.models.some((item) => item.id === model)) return;
    const unavailable = fromEditor
      ? "baseUrl" in saved
        ? connectionTestUnavailable(saved, edit, { secret, username }, "keep", platforms.find((item) => item.alias === saved.alias))
        : connectionTestUnavailable(saved, connectionEdit, connectionSecrets, sshIdentity, connections.find((item) => item.alias === saved.alias))
      : connectionTestUnavailable(saved);
    if (unavailable) return;
    clearConnectionTest();
    const generation = connectionTestGeneration.current;
    const controller = new AbortController();
    connectionTestController.current = controller;
    connectionTestInFlight.current = true;
    setConnectionTestPending(saved.alias);
    setConnectionTestResult({ alias: saved.alias, revision: saved.revision!, status: "pending", message: "正在读取已保存连接的验证方案…" });
    const timeout = window.setTimeout(() => controller.abort(new Error("test-timeout")), 35000);
    try {
      const base = `/admin/${"baseUrl" in saved ? "platforms" : "connections"}/${encodeURIComponent(saved.alias)}`;
      let plan = readConnectionTestPlan(await api(`${base}/test-plan`, "GET", undefined, csrf, controller.signal), saved);
      if (generation !== connectionTestGeneration.current) return;
      if (!plan.supported) {
        setConnectionTestResult({ alias: saved.alias, revision: saved.revision!, status: "unsupported", message: plan.message, plan });
        return;
      }
      if (plan.billing === "possible" && !allowBillable) {
        setConnectionTestResult({ alias: saved.alias, revision: saved.revision!, status: "confirmation", message: `${plan.message} 尚未发送请求；确认后只执行一次。`, plan });
        return;
      }
      if (plan.generation) {
        if (!plan.generation.models.some((item) => item.id === model))
          throw Object.assign(new Error("Model choice changed"), { code: "CONNECTION_TEST_CONSENT" });
        plan = { ...plan, model };
      }
      setConnectionTestResult({ alias: saved.alias, revision: saved.revision!, status: "pending", message: plan.message, plan });
      const result = await api(`${base}/connection-test`, "POST", {
        expectedRevision: saved.revision, ...(allowBillable ? { allowBillable: true } : {}),
        ...(plan.generation ? { model } : {}),
      }, csrf, controller.signal);
      if (generation !== connectionTestGeneration.current) return;
      if (result.alias !== saved.alias || result.revision !== saved.revision ||
        !["verified", "reachable", "unsupported"].includes(result.status) || typeof result.message !== "string" ||
        (result.status === "verified" && !["authentication", "generation"].includes(plan.level)) ||
        (plan.generation && result.model !== model))
        throw Object.assign(new Error("Invalid connection-test response"), { code: "INVALID_RESPONSE" });
      setConnectionTestResult({ alias: saved.alias, revision: saved.revision!, status: result.status,
        message: result.message, plan, durationMs: typeof result.durationMs === "number" && Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : undefined });
    } catch (failure) {
      if (generation === connectionTestGeneration.current)
        setConnectionTestResult((current) => ({ alias: saved.alias, revision: saved.revision!, status: "failed",
          message: connectionTestError(controller.signal.aborted ? { code: "CONNECTION_TEST_TIMEOUT" } : failure) +
            (current?.plan?.generation ? "。若请求已被服务商受理，仍可能计费；未自动重试。" : ""), plan: current?.plan }));
    } finally {
      window.clearTimeout(timeout);
      if (connectionTestController.current === controller) {
        connectionTestController.current = null;
        connectionTestInFlight.current = false;
        setConnectionTestPending(null);
      }
    }
  }
  async function saveConnection(event: React.FormEvent, trustBoundary: Connection["trustBoundary"]) {
    event.preventDefault();
    if (!connectionEdit) return;
    setBusy(true);
    setError("");
    try {
      requireConfigurationCompatible(formVersion);
      if (!trustBoundary) throw new Error("请确认远端及所用账号无法管理 Abilock 所在电脑");
      const body = connectionWrite(
        { ...connectionEdit, trustBoundary },
        connectionOriginal,
        connectionSecrets,
        sshIdentity,
      );
      await api(
        `/admin/connections/${encodeURIComponent(connectionOriginal?.alias ?? body.connection.alias)}`,
        "PUT",
        body,
      );
      closeConnection();
      const refreshed = await refreshAfterWrite("已保存");
      if (connectionOriginal?.alias === selectedManual) setSelectedManual(refreshed ? body.connection.alias : null);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setConnectionSecrets({});
      setBusy(false);
    }
  }
  async function remove(item: Platform | Connection) {
    if (!isConfigurationCompatible(formVersion)) {
      setError(configurationRestartMessage);
      return;
    }
    const gitWorkspaces = "kind" in item && item.kind === "git"
      ? "\n同时删除该连接在 Abilock 中的 Git 工作区，未推送的提交会丢失。" : "";
    if (!confirm(`删除 ${item.alias}？${gitWorkspaces}`)) return;
    setBusy(true);
    setError("");
    try {
      const kind = "baseUrl" in item ? "platforms" : "connections";
      await api(`/admin/${kind}/${encodeURIComponent(item.alias)}`, "DELETE", {
        expectedRevision: item.revision,
      });
      await refreshAfterWrite("已删除");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function removeUnrecognized(alias: string) {
    if (!confirm(`删除无法识别的记录 ${alias} 及其手册？此操作不能撤销。`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/unrecognized/${encodeURIComponent(alias)}`, "DELETE");
      await refreshAfterWrite("已删除");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const matchesSearch = matchesConnection(search);
  const initial = !!authState && !authState.initialized && !authState.legacy;
  const configurationReady = isConfigurationCompatible(formVersion);
  const configurationAlert = !configurationReady ? (
    <div className="error" role="alert">
      {configurationRestartMessage}
    </div>
  ) : null;
  const alert = error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;
  if (!logged)
    return (
      <LoginView
        ready={!!authState}
        initial={initial}
        password={password}
        confirmation={confirmation}
        busy={busy}
        alert={alert}
        onPassword={setPassword}
        onConfirmation={setConfirmation}
        onSubmit={login}
      />
    );
  const connectionTestDisabled = busy || keyReading || refreshing || !!connectionTestPending || !configurationReady;
  const manualOwner = selectedManual === null ? undefined :
    platforms.find((platform) => platform.alias === selectedManual) ??
    connections.find((connection) => connection.alias === selectedManual);
  const manualGuide = selectedManual === null ? undefined :
    protocolGuides.find((guide) => guide.alias === selectedManual);
  const everything: (Platform | Connection)[] = [...platforms, ...connections];
  const categoryCounts = categoryLabels.map((label) => ({
    label,
    count: everything.filter((item) => inCategory(item, label)).length,
  })).filter((item) => item.label === "全部" || item.count > 0);
  const manualLinks = [
    ...platforms.filter(matchesSearch).map((item) => ({ alias: item.alias, note: item.note, kind: "api" as const })),
    ...connections.filter(matchesSearch).map((item) => ({ alias: item.alias, note: item.note, kind: item.kind })),
  ];
  const syncText = refreshError ||
    (lastSynced ? `已刷新 ${lastSynced.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "加载中");
  return (
    <main className="app">
      <aside className="sidebar" aria-label="导航">
        <Brand />
        <label className="search-field">
          <span className="sr-only">搜索连接</span>
          <SearchIcon />
          <input type="search" value={search} placeholder="搜索" autoComplete="off"
            onChange={(event) => setSearch(event.target.value)} />
        </label>
        <div className="sidebar-scroll">
          <p className="sidebar-label">连接</p>
          <div className="sidebar-group">
            {categoryCounts.map(({ label, count }) => (
              <button
                key={label}
                className={`nav-item ${selectedManual === null && filter === label ? "selected" : ""}`}
                aria-pressed={selectedManual === null && filter === label}
                onClick={() => {
                  setFilter(label);
                  setSelectedManual(null);
                }}
              >
                <CategoryIcon category={label} />
                <span className="nav-text">{label === "全部" ? "全部连接" : label}</span>
                <span className="nav-count">{count}</span>
              </button>
            ))}
          </div>
          <p className="sidebar-label">手册</p>
          <div className="sidebar-group">
            {!everything.length && <p className="sidebar-empty">暂无手册</p>}
            {manualLinks.map((item) => (
              <button
                key={item.alias}
                className={`manual-link ${selectedManual === item.alias ? "selected" : ""}`}
                onClick={() => setSelectedManual(item.alias)}
              >
                <ProtocolGlyph kind={item.kind} size="small" />
                <span className="manual-link-text">
                  <span>{item.alias}</span>
                  {item.note && <small className="manual-link-note" title={item.note}>{item.note}</small>}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="sidebar-footer">
          <button
            className="footer-button"
            disabled={busy}
            onClick={() => {
              setError("");
              setPasswordEdit(true);
            }}
          >
            <KeyIcon />
            密码
          </button>
          <button className="footer-button" disabled={busy} onClick={logout}>
            <LogoutIcon />
            退出
          </button>
        </div>
      </aside>
      <section
        className="content"
        aria-label={selectedManual ? "手册" : "连接"}
      >
        <div className="content-inner">
          {selectedManual === null && (
            <div className="page-header">
              <div className="page-title">
                <h1>连接</h1>
                <p>
                  {filter === "全部" ? `${everything.length} 个连接` : `${filter} · ${everything.filter((item) => inCategory(item, filter)).length} 个`}
                  <span className="dot-separator" aria-hidden="true">·</span>
                  <span role="status" className={refreshError ? "sync-error" : ""}>{syncText}</span>
                </p>
              </div>
              <div className="page-actions">
                <button
                  type="button"
                  className={`icon-button ${refreshing ? "spinning" : ""}`}
                  aria-label="刷新"
                  title="刷新"
                  disabled={refreshPaused || refreshing}
                  onClick={refreshNow}
                >
                  <RefreshIcon />
                </button>
                <button
                  className="primary"
                  disabled={busy || !configurationReady}
                  onClick={() => beginAdd()}
                >
                  <PlusIcon />
                  添加
                </button>
              </div>
            </div>
          )}
          {configurationAlert}
          {!edit && !connectionEdit && !manualEdit && !passwordEdit && alert}
          {exportWarning && <div className="callout" role="status">{exportWarning}</div>}
          {selectedManual === null ? (
            <>
              <UnrecognizedRecords
                records={unrecognized}
                disabled={busy || !configurationReady}
                onRemove={(alias) => void removeUnrecognized(alias)}
              />
              <ConnectionList
                platforms={platforms}
                connections={connections}
                filter={filter}
                query={search}
                actionsDisabled={busy || !configurationReady}
                connectionTest={{
                  disabled: connectionTestDisabled,
                  pending: connectionTestPending,
                  result: connectionTestResult,
                  onTest: (connection) => void testSavedConnection(connection),
                  onCancel: cancelConnectionTest,
                  onConfirm: (connection, model) => void testSavedConnection(connection, false, true, model),
                }}
                onAdd={() => beginAdd()}
                onEditPlatform={beginEdit}
                onEditConnection={beginConnection}
                onRemove={(item) => void remove(item)}
              />
            </>
          ) : (
            <ManualPanel
              alias={selectedManual}
              owner={manualOwner}
              manuals={docs.filter((doc) => doc.alias === selectedManual)}
              guide={manualGuide ? { title: manualGuide.title, markdown: guideMarkdown[manualGuide.kind] ?? "" } : undefined}
              stale={documentationStatuses[selectedManual] === "stale" ||
                (manualOwner?.learnedDocumentationUrl !== undefined &&
                  manualOwner.learnedDocumentationUrl !== (manualOwner.documentationUrl ?? null))}
              busy={busy}
              configurationReady={configurationReady}
              onEditOwner={(owner) => "baseUrl" in owner ? beginEdit(owner) : beginConnection(owner)}
              onEditManual={beginManual}
              onBack={() => setSelectedManual(null)}
            />
          )}
        </div>
      </section>
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {manualEdit && <Modal title="编辑手册" wide busy={busy} onClose={closeManual}>
        <ManualEditor draft={manualEdit} onChange={(draft) => {
          if (draft.revision !== manualEdit.revision) setError("");
          setManualEdit(draft);
        }} onSubmit={saveManual} busy={busy}
          error={error} latest={manualLatest} onLoadLatest={loadLatestManual} loadingLatest={loadingLatest} />
      </Modal>}
      {edit && (
        <PlatformEditor
          edit={edit}
          original={original}
          saved={platforms.find((item) => item.alias === original?.alias)}
          connectionTest={{
            disabled: connectionTestDisabled,
            pending: connectionTestPending === original?.alias,
            result: connectionTestResult,
            onTest: () => { if (original) void testSavedConnection(original, true); },
            onCancel: cancelConnectionTest,
            onConfirm: (model) => { if (original) void testSavedConnection(original, true, true, model); },
          }}
          secret={secret}
          username={username}
          adapters={adapters}
          busy={busy}
          configurationReady={configurationReady}
          configurationAlert={configurationAlert}
          alert={alert}
          onEdit={setEdit}
          onAuth={changeAuth}
          onSecret={setSecret}
          onUsername={setUsername}
          onKind={beginAdd}
          onClose={closeEdit}
          onSubmit={save}
        />
      )}
      {connectionEdit && (
        <ConnectionEditor
          edit={connectionEdit}
          original={connectionOriginal}
          saved={connections.find((item) => item.alias === connectionOriginal?.alias)}
          secrets={connectionSecrets}
          sshIdentity={sshIdentity}
          busy={busy}
          keyReading={keyReading}
          configurationReady={configurationReady}
          configurationAlert={configurationAlert}
          alert={alert}
          connectionTest={{
            disabled: connectionTestDisabled,
            pending: connectionTestPending === connectionOriginal?.alias,
            result: connectionTestResult,
            onTest: () => { if (connectionOriginal) void testSavedConnection(connectionOriginal, true); },
            onCancel: cancelConnectionTest,
            onConfirm: () => { if (connectionOriginal) void testSavedConnection(connectionOriginal, true, true); },
          }}
          onEdit={setConnectionEdit}
          onFieldsChange={changeConnection}
          onIdentity={(identity) => {
            setSshIdentity(identity);
            setConnectionSecrets({});
          }}
          onSecrets={setConnectionSecrets}
          onKeyReading={setKeyReading}
          onKeyError={setError}
          onKind={beginAdd}
          onClose={closeConnection}
          onSubmit={saveConnection}
        />
      )}
      {passwordEdit && (
        <PasswordDialog
          requireCurrent={!!authState?.initialized}
          currentPassword={currentPassword}
          password={password}
          confirmation={confirmation}
          busy={busy}
          alert={alert}
          onCurrentPassword={setCurrentPassword}
          onPassword={setPassword}
          onConfirmation={setConfirmation}
          onClose={closePassword}
          onSubmit={savePassword}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
