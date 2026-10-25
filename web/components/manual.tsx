import React from "react";

export function publicDocUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function inline(text: string): React.ReactNode[] {
  const pieces = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("`") && piece.endsWith("`"))
      return <code key={index}>{piece.slice(1, -1)}</code>;
    if (piece.startsWith("**") && piece.endsWith("**"))
      return <strong key={index}>{piece.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(piece);
    const url = link && publicDocUrl(link[2]);
    if (link && url)
      return (
        <a key={index} href={url} target="_blank" rel="noopener noreferrer">
          {link[1]}
        </a>
      );
    return piece;
  });
}
export function Manual({ markdown }: { markdown: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*```/.test(line)) {
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i]))
        code.push(lines[i]);
      blocks.push(
        <pre key={i}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const tag = `h${Math.min(heading[1].length + 1, 6)}`;
      blocks.push(React.createElement(tag, { key: i }, inline(heading[2])));
      continue;
    }
    if (/^\s*([-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      do {
        items.push(
          <li key={i}>
            {inline(lines[i].replace(/^\s*(?:[-*+] |\d+\. )/, ""))}
          </li>,
        );
        i++;
      } while (
        i < lines.length &&
        (ordered ? /^\s*\d+\. / : /^\s*[-*+] /).test(lines[i])
      );
      i--;
      blocks.push(
        ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      blocks.push(
        <blockquote key={i}>{inline(line.replace(/^\s*>\s?/, ""))}</blockquote>,
      );
      continue;
    }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={i} />);
      continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const cells = (value: string) =>
        value
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
      const headers = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|"))
        rows.push(cells(lines[i++]));
      i--;
      blocks.push(
        <div className="manual-table" key={i}>
          <table>
            <thead>
              <tr>
                {headers.map((cell, n) => (
                  <th key={n}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, n) => (
                <tr key={n}>
                  {row.map((cell, j) => (
                    <td key={j}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const paragraph = [line];
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() &&
      !/^(?:\s*```|#{1,6}\s|\s*[-*+] |\s*\d+\. |\s*>)/.test(lines[i + 1])
    )
      paragraph.push(lines[++i]);
    blocks.push(<p key={i}>{inline(paragraph.join("\n"))}</p>);
  }
  return <article className="manual-content">{blocks}</article>;
}
