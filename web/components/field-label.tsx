import type { ReactNode } from "react";

export function FieldLabel({ children, required = false }: {
  children: ReactNode;
  required?: boolean;
}) {
  return <span className="field-label">
    {children}{required && <span className="required-mark" aria-hidden="true">*</span>}
  </span>;
}
