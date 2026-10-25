import React from "react";
import type { ConnectionKind } from "./connection-form.js";

// Small stroke icons drawn on a 20px grid. Decorative only: every control that
// uses one also carries a text label or aria-label.
function Icon({ children, size = 16 }: { children: React.ReactNode; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}
export const PlusIcon = () => (
  <Icon>
    <path d="M10 4.5v11M4.5 10h11" />
  </Icon>
);
export const RefreshIcon = () => (
  <Icon>
    <path d="M15.5 9.5a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M15.6 3.8v3.4h-3.4" />
  </Icon>
);
export const PencilIcon = () => (
  <Icon>
    <path d="M12.8 4.2l3 3-8.6 8.6-3.7.7.7-3.7z" />
    <path d="M11.2 5.8l3 3" />
  </Icon>
);
export const TrashIcon = () => (
  <Icon>
    <path d="M4.5 6h11M8.2 6V4.5h3.6V6M6 6l.7 9.5h6.6L14 6" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon size={14}>
    <circle cx="8.8" cy="8.8" r="4.8" />
    <path d="M12.4 12.4l3.6 3.6" />
  </Icon>
);
export const BackIcon = () => (
  <Icon>
    <path d="M11.8 5l-5 5 5 5" />
  </Icon>
);
export const CloseIcon = () => (
  <Icon>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </Icon>
);
export const KeyIcon = () => (
  <Icon>
    <circle cx="7" cy="12.5" r="3" />
    <path d="M9.2 10.3l6.3-6.3M13.4 6.1l1.8 1.8" />
  </Icon>
);
export const LogoutIcon = () => (
  <Icon>
    <path d="M8 4.5H5.2a.7.7 0 0 0-.7.7v9.6c0 .4.3.7.7.7H8" />
    <path d="M11.5 7l3 3-3 3M14.5 10H8" />
  </Icon>
);
export const LayersIcon = () => (
  <Icon>
    <path d="M10 3.8l6 3.2-6 3.2-6-3.2z" />
    <path d="M4 10.2l6 3.2 6-3.2M4 13.2l6 3.2 6-3.2" />
  </Icon>
);
// A monogram tile per protocol: colour groups the family, letters name it.
const glyphs: Record<ConnectionKind | "api", { text: string; tone: string }> = {
  api: { text: "API", tone: "cobalt" },
  ssh: { text: "SSH", tone: "graphite" },
  postgres: { text: "PG", tone: "slate" },
  mysql: { text: "MY", tone: "amber" },
  redis: { text: "RD", tone: "red" },
  git: { text: "GIT", tone: "orange" },
  s3: { text: "S3", tone: "teal" },
  aws: { text: "AWS", tone: "amber" },
  registry: { text: "REG", tone: "violet" },
  docker: { text: "DKR", tone: "sky" },
  kubernetes: { text: "K8s", tone: "cobalt" },
};
export function ProtocolGlyph({
  kind,
  size = "regular",
}: {
  kind: ConnectionKind | "api";
  size?: "small" | "regular" | "large";
}) {
  const glyph = glyphs[kind];
  return (
    <span className={`glyph glyph-${glyph.tone} glyph-${size}`} aria-hidden="true">
      {glyph.text}
    </span>
  );
}
const CodeIcon = () => (
  <Icon>
    <path d="M7.5 6.5L4 10l3.5 3.5M12.5 6.5L16 10l-3.5 3.5" />
  </Icon>
);
const TerminalIcon = () => (
  <Icon>
    <rect x="3.5" y="4.5" width="13" height="11" rx="2" />
    <path d="M6.5 8.5l2 1.5-2 1.5M10 12h3.5" />
  </Icon>
);
const DatabaseIcon = () => (
  <Icon>
    <ellipse cx="10" cy="5.8" rx="5.5" ry="2" />
    <path d="M4.5 5.8v8.4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V5.8M4.5 10c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" />
  </Icon>
);
const BoxIcon = () => (
  <Icon>
    <path d="M3.8 6.6L10 3.8l6.2 2.8v6.8L10 16.2l-6.2-2.8z" />
    <path d="M3.8 6.6L10 9.4l6.2-2.8M10 9.4v6.8" />
  </Icon>
);
const CloudIcon = () => (
  <Icon>
    <path d="M6.2 15h7.6a3.2 3.2 0 0 0 .4-6.4 4.4 4.4 0 0 0-8.5 1A2.7 2.7 0 0 0 6.2 15z" />
  </Icon>
);
const GridIcon = () => (
  <Icon>
    <rect x="4" y="4" width="5" height="5" rx="1.2" />
    <rect x="11" y="4" width="5" height="5" rx="1.2" />
    <rect x="4" y="11" width="5" height="5" rx="1.2" />
    <rect x="11" y="11" width="5" height="5" rx="1.2" />
  </Icon>
);
export function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case "API":
      return <CodeIcon />;
    case "SSH":
      return <TerminalIcon />;
    case "数据库":
      return <DatabaseIcon />;
    case "存储":
      return <BoxIcon />;
    case "云":
      return <CloudIcon />;
    case "其他":
      return <GridIcon />;
    default:
      return <LayersIcon />;
  }
}
