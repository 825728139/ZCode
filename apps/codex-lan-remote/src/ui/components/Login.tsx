import { useState } from "react";
import { Smartphone } from "lucide-react";
import type { CurrentUser } from "../../contract.js";
import { api } from "../api.js";

export function Login({ onLogin }: { onLogin(user: CurrentUser): void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="auth-shell">
      <form
        className="auth-panel"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void api
            .login(email, password)
            .then(({ user }) => onLogin(user))
            .catch((reason: Error) => setError(reason.message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="brand-mark">
          <Smartphone size={20} />
          <span>Codex Remote</span>
        </div>
        <h1>登录服务器</h1>
        <label>
          邮箱
          <input
            autoComplete="username"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          密码
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error && <p className="error-banner">{error}</p>}
        <button className="primary-button" disabled={busy}>
          {busy ? "登录中..." : "登录"}
        </button>
      </form>
    </main>
  );
}
