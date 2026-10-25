import { useEffect, useRef, useState } from "react";

type LocalFile = Pick<File, "size" | "text">;
export async function readPrivateKeyFile(file: LocalFile): Promise<string> {
  if (!Number.isFinite(file.size) || file.size < 1 || file.size > 100000)
    throw new Error("私钥文件须为 1–100000 字节");
  let value: string;
  try { value = await file.text(); }
  catch { throw new Error("无法读取私钥文件"); }
  if (!value.trim() || value.length > 100000 || value.includes("\0"))
    throw new Error("请选择文本格式的私钥文件");
  return value;
}
export function PrivateKeyFile({ disabled, onValue, onError, onReading }: {
  disabled: boolean;
  onValue: (value: string) => void;
  onError: (message: string) => void;
  onReading: (value: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const [reading, setReading] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  return <span className="private-key-file">
    <input ref={input} type="file" className="private-key-input" aria-label="选择私钥文件" disabled={disabled || reading}
      onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        setReading(true); onReading(true);
        try {
          const value = await readPrivateKeyFile(file);
          if (active.current) onValue(value);
        } catch (error) {
          if (active.current) onError((error as Error).message);
        } finally {
          if (active.current) setReading(false);
          onReading(false);
        }
      }} />
    <button type="button" disabled={disabled || reading} onClick={() => input.current?.click()}>
      {reading ? "读取中…" : "选择文件"}
    </button>
  </span>;
}
