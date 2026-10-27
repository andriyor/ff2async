// Adding promisify/callbackify and removing the ff import.

import { Project, SourceFile, SyntaxKind } from "ts-morph";
import { findFfImport } from "./find";
import { isPropertyName } from "./util";

export function fixImports(project: Project, fileName: string, text: string, used: Set<string>): string {
  const sf = project.createSourceFile(fileName, text, { overwrite: true });
  const imp = findFfImport(sf);
  const needed = [...used].sort().filter((n) => !isBoundAtTop(sf, n));
  if (!imp) return text;
  // Add to an existing `import { ... } from "util"` instead of a second one.
  const utilImport = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === "util" && d.getNamedImports().length);
  if (needed.length && utilImport) {
    utilImport.addNamedImports(needed);
    return fixImports(project, fileName, sf.getFullText(), new Set());
  }
  const stillUsed = sf.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === imp.name && !id.getFirstAncestor((a) => a === imp.stmt) && !isPropertyName(id));
  const q = imp.quote;
  const line = needed.length
    ? imp.esm
      ? `import { ${needed.join(", ")} } from ${q}util${q};`
      : `const { ${needed.join(", ")} } = require(${q}util${q});`
    : "";
  if (stillUsed) {
    return line ? text.slice(0, imp.stmt.getEnd()) + "\n" + line + text.slice(imp.stmt.getEnd()) : text;
  }
  // Drop the ff import, and a `// @ts-ignore` that was only there for it.
  let start = imp.stmt.getStart();
  const ignore = imp.stmt.getLeadingCommentRanges().filter((c) => c.getText().includes("@ts-ignore")).pop();
  if (ignore) start = ignore.getPos();
  let end = imp.stmt.getEnd();
  if (!line) {
    while (start > 0 && text[start - 1] !== "\n" && /\s/.test(text[start - 1])) start--;
    if (text[end] === "\n") end++;
  }
  return text.slice(0, start) + line + text.slice(end);
}

export function isBoundAtTop(sf: SourceFile, name: string): boolean {
  return (
    !!sf.getVariableDeclaration(name) ||
    sf.getImportDeclarations().some((d) => d.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name))
  );
}
