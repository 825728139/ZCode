import { useEffect, useMemo, useState } from "react";
import {
  CircleUserRound,
  FolderKanban,
  KeyRound,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import type {
  CurrentUser,
  RemoteEvent,
  RuntimeConnectionInfo,
  WorkspaceSummary,
} from "../contract.js";
import { api } from "./api.js";
import { Conversation, Message, PromptInput } from "./components/ai-elements.js";
import { AccountSettings } from "./components/AccountSettings.js";
import { Login } from "./components/Login.js";
import {
  commandId,
  liveMessages,
  snapshotMessages,
  type ThreadRecord,
  threadRows,
  threadTitle,
  toRecord,
} from "./messageProjection.js";
import { useRemoteSocket } from "./useRemoteSocket.js";

export function App() {
  const [user, setUser] = useState<CurrentUser | null | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [newWorkspace, setNewWorkspace] = useState("");
  const [panel, setPanel] = useState<"none" | "settings" | "create">("none");
  const [mobileNav, setMobileNav] = useState(false);
  const [notice, setNotice] = useState("");
  const [runtimeConnection, setRuntimeConnection] = useState<RuntimeConnectionInfo | null>(null);
  const socket = useRemoteSocket(workspace?.id ?? null);
  const canUseRuntime = Boolean(user?.hasOpenAiKey || user?.usesSharedCodexAuth);

  const refreshWorkspaces = () =>
    void api
      .workspaces()
      .then(({ workspaces: value }) => setWorkspaces(value))
      .catch((error: Error) => setNotice(error.message));
  const refreshThreads = () => {
    if (!workspace || !canUseRuntime) return;
    void api
      .threads(workspace.id)
      .then((value) => setThreads(threadRows(value)))
      .catch((error: Error) => setNotice(error.message));
  };

  useEffect(() => {
    void api
      .me()
      .then(({ user: value }) => setUser(value))
      .catch(() => setUser(null));
  }, []);
  useEffect(() => {
    if (user) refreshWorkspaces();
  }, [user?.id]);
  useEffect(() => {
    setThreads([]);
    setThreadId(null);
    refreshThreads();
  }, [workspace?.id, canUseRuntime]);
  useEffect(() => {
    setRuntimeConnection(null);
    if (!workspace || !user?.usesSharedCodexAuth) return;
    void api
      .runtimeConnection(workspace.id)
      .then(setRuntimeConnection)
      .catch((error: Error) => setNotice(error.message));
  }, [workspace?.id, user?.usesSharedCodexAuth]);
  useEffect(() => {
    const result = [...socket.events].reverse().find((event) => event.type === "command.result");
    if (!result || result.type !== "command.result") return;
    const returnedThread = toRecord(toRecord(result.result).thread);
    const id = returnedThread.id;
    if (typeof id === "string" && !threadId) {
      setThreadId(id);
      refreshThreads();
    }
  }, [socket.events]);

  const visibleMessages = useMemo(
    () => [...snapshotMessages(socket.events), ...liveMessages(socket.events)],
    [socket.events],
  );
  const approvals = socket.events.filter((event) => event.type === "approval.requested") as Extract<
    RemoteEvent,
    { type: "approval.requested" }
  >[];

  if (user === undefined)
    return (
      <main className="center-state">
        <RefreshCw className="spin" size={24} />
      </main>
    );
  if (!user) return <Login onLogin={setUser} />;

  const sendPrompt = () => {
    if (!threadId || !draft.trim()) return;
    socket.send({ type: "turn.start", clientCommandId: commandId(), threadId, text: draft.trim() });
    setDraft("");
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <button
          className="icon-button mobile-only"
          title="导航"
          aria-label="导航"
          onClick={() => setMobileNav(true)}
        >
          <Menu size={18} />
        </button>
        <div className="brand-mark">
          <Smartphone size={18} />
          <span>Codex Remote</span>
        </div>
        <div className={`connection ${socket.connected ? "online" : ""}`}>
          <span />
          {socket.connected ? "已连接" : "未连接"}
        </div>
        <button
          className="icon-button"
          title="设置"
          aria-label="设置"
          onClick={() => setPanel("settings")}
        >
          <Settings size={18} />
        </button>
        <button
          className="icon-button"
          title="退出登录"
          aria-label="退出登录"
          onClick={() => void api.logout().finally(() => setUser(null))}
        >
          <LogOut size={18} />
        </button>
      </header>

      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <div className="sidebar-heading">
          <span>工作区</span>
          <button
            className="icon-button"
            title="新建工作区"
            aria-label="新建工作区"
            onClick={() => setPanel("create")}
          >
            <Plus size={17} />
          </button>
        </div>
        <nav>
          {workspaces.map((item) => (
            <button
              key={item.id}
              className={`nav-row ${workspace?.id === item.id ? "active" : ""}`}
              onClick={() => {
                setWorkspace(item);
                setMobileNav(false);
              }}
            >
              <FolderKanban size={17} />
              <span>{item.name}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-user">
          <CircleUserRound size={18} />
          <span>
            <strong>{user.displayName}</strong>
            <small>{user.email}</small>
          </span>
        </div>
      </aside>

      <aside className="threadbar">
        <div className="sidebar-heading">
          <span>会话</span>
          <span className="row-actions">
            <button className="icon-button" title="刷新" aria-label="刷新" onClick={refreshThreads}>
              <RefreshCw size={16} />
            </button>
            <button
              className="icon-button"
              title="新建会话"
              aria-label="新建会话"
              disabled={!workspace || !socket.connected || !socket.writable}
              onClick={() => socket.send({ type: "thread.start", clientCommandId: commandId() })}
            >
              <Plus size={17} />
            </button>
          </span>
        </div>
        {!canUseRuntime && (
          <button className="setup-row" onClick={() => setPanel("settings")}>
            <KeyRound size={17} />
            配置 API Key
          </button>
        )}
        {threads.map((thread) => (
          <button
            className={`thread-row ${threadId === thread.id ? "active" : ""}`}
            key={String(thread.id)}
            onClick={() => {
              const id = String(thread.id);
              setThreadId(id);
              socket.send({ type: "thread.subscribe", threadId: id });
            }}
          >
            {threadTitle(thread)}
          </button>
        ))}
      </aside>

      <main className="main-panel">
        {!workspace ? (
          <div className="empty-state">
            <FolderKanban size={28} />
            <h2>选择工作区</h2>
          </div>
        ) : (
          <>
            <div className="session-header">
              <div>
                <h2>
                  {threadId
                    ? threads.find((item) => item.id === threadId)
                      ? threadTitle(threads.find((item) => item.id === threadId)!)
                      : "新会话"
                    : workspace.name}
                </h2>
                <p>
                  {user.usesSharedCodexAuth ? "共享 app-server · " : ""}
                  {socket.writable ? "可控制" : "只读连接"}
                </p>
              </div>
              <button
                className="control-button"
                disabled={!socket.connected}
                onClick={() => socket.send({ type: "control.acquire", takeover: true })}
              >
                <ShieldCheck size={17} />
                {socket.writable ? "续期控制" : "接管"}
              </button>
            </div>
            <Conversation>
              {!threadId && (
                <div className="empty-state compact">
                  <h2>新建或选择会话</h2>
                </div>
              )}
              {visibleMessages.map((message, index) => (
                <Message key={index} role={message.role}>
                  <pre>{message.text}</pre>
                </Message>
              ))}
              {approvals.slice(-1).map((approval) => (
                <section className="approval" key={approval.requestId}>
                  <strong>等待审批</strong>
                  <code>{approval.method}</code>
                  <div>
                    <button
                      onClick={() =>
                        socket.send({
                          type: "approval.resolve",
                          clientCommandId: commandId(),
                          requestId: approval.requestId,
                          decision: "decline",
                        })
                      }
                    >
                      拒绝
                    </button>
                    <button
                      className="primary-button"
                      onClick={() =>
                        socket.send({
                          type: "approval.resolve",
                          clientCommandId: commandId(),
                          requestId: approval.requestId,
                          decision: "accept",
                        })
                      }
                    >
                      允许
                    </button>
                  </div>
                </section>
              ))}
            </Conversation>
            <PromptInput
              value={draft}
              disabled={!socket.writable || !threadId}
              onChange={setDraft}
              onSubmit={sendPrompt}
            />
          </>
        )}
      </main>

      {(notice || socket.error) && (
        <div className="toast" role="alert">
          {notice || socket.error}
          <button
            className="icon-button"
            aria-label="关闭"
            onClick={() => {
              setNotice("");
              socket.setError("");
            }}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {panel !== "none" && (
        <div className="overlay" onMouseDown={() => setPanel("none")}>
          <section className="dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="dialog-title">
              <h2>{panel === "settings" ? "账户设置" : "新建工作区"}</h2>
              <button className="icon-button" aria-label="关闭" onClick={() => setPanel("none")}>
                <X size={18} />
              </button>
            </div>
            {panel === "settings" ? (
              <AccountSettings
                user={user}
                apiKey={apiKey}
                runtimeConnection={runtimeConnection}
                onApiKeyChange={setApiKey}
                onSaved={() => {
                  setUser({ ...user, hasOpenAiKey: true });
                  setWorkspace(null);
                  setApiKey("");
                  setPanel("none");
                }}
                onError={(error) => setNotice(error.message)}
              />
            ) : (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void api
                    .createWorkspace(newWorkspace)
                    .then(({ workspace: value }) => {
                      setWorkspaces((current) => [...current, value]);
                      setWorkspace(value);
                      setMobileNav(false);
                      setNewWorkspace("");
                      setPanel("none");
                    })
                    .catch((error: Error) => setNotice(error.message));
                }}
              >
                <label>
                  工作区名称
                  <input
                    value={newWorkspace}
                    onChange={(event) => setNewWorkspace(event.target.value)}
                    required
                  />
                </label>
                <button className="primary-button">创建</button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
