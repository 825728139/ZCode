import type { FormEvent, ReactNode } from "react";
import { SendHorizontal } from "lucide-react";

export function Conversation({ children }: { children: ReactNode }) {
  return (
    <div className="conversation" aria-live="polite">
      {children}
    </div>
  );
}

export function Message({
  role,
  children,
}: {
  role: "user" | "assistant" | "tool";
  children: ReactNode;
}) {
  return (
    <article className={`message message-${role}`}>
      <span className="message-role">{role}</span>
      {children}
    </article>
  );
}

export function PromptInput(props: {
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  onSubmit(): void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit();
  };
  return (
    <form className="prompt" onSubmit={submit}>
      <textarea
        aria-label="发送消息"
        placeholder={props.disabled ? "接管控制权后可输入" : "给 Codex 发送消息"}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            props.onSubmit();
          }
        }}
        rows={2}
      />
      <button
        className="icon-button primary"
        disabled={props.disabled || !props.value.trim()}
        title="发送"
        aria-label="发送"
      >
        <SendHorizontal size={18} />
      </button>
    </form>
  );
}
