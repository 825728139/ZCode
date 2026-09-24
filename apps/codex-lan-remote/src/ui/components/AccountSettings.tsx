import { SquareTerminal } from "lucide-react";
import type { CurrentUser, RuntimeConnectionInfo } from "../../contract.js";
import { api } from "../api.js";

interface AccountSettingsProps {
  user: CurrentUser;
  apiKey: string;
  runtimeConnection: RuntimeConnectionInfo | null;
  onApiKeyChange(value: string): void;
  onSaved(): void;
  onError(error: Error): void;
}

export function AccountSettings({
  user,
  apiKey,
  runtimeConnection,
  onApiKeyChange,
  onSaved,
  onError,
}: AccountSettingsProps) {
  if (user.usesSharedCodexAuth) {
    return (
      <section className="runtime-connection">
        <div>
          <SquareTerminal size={18} />
          <span>
            <strong>共享主机认证</strong>
            <small>CLI 与浏览器连接同一个 app-server</small>
          </span>
        </div>
        {runtimeConnection ? (
          <code>{runtimeConnection.cliArgs.join(" ")}</code>
        ) : (
          <p>选择工作区后显示 CLI 连接命令。</p>
        )}
      </section>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void api.setKey(apiKey).then(onSaved).catch(onError);
      }}
    >
      <label>
        OpenAI API Key
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={user.hasOpenAiKey ? "已配置，输入新值以替换" : "sk-..."}
          required
        />
      </label>
      <button className="primary-button">保存 Key</button>
    </form>
  );
}
