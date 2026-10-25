import React, { useId, useState } from "react";
import { passwordMaximumUtf16Units } from "../../src/password-policy.js";

export function PasswordInput(props: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "maxLength">) {
  const [capsLock, setCapsLock] = useState(false);
  const hintId = useId();
  const { onKeyDown, onKeyUp, onBlur, "aria-describedby": describedBy, ...inputProps } = props;
  const description = [describedBy, capsLock ? hintId : undefined].filter(Boolean).join(" ") || undefined;
  // Read keyboard state only. The value remains an ordinary protected password
  // input; neither the hint nor the native Caps Lock decoration reveals it.
  return <span className="password-control">
    <input {...inputProps} type="password" maxLength={passwordMaximumUtf16Units}
      aria-describedby={description}
      onKeyDown={(event) => {
        setCapsLock(event.getModifierState("CapsLock"));
        onKeyDown?.(event);
      }}
      onKeyUp={(event) => {
        setCapsLock(event.getModifierState("CapsLock"));
        onKeyUp?.(event);
      }}
      onBlur={(event) => {
        setCapsLock(false);
        onBlur?.(event);
      }} />
    <span className="password-keyboard-hint" id={hintId} role="status" aria-live="polite">
      {capsLock ? "大写锁定已开启（Caps Lock）" : ""}
    </span>
  </span>;
}
