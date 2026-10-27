// Locating the ff import and the chains in a file.

import { CallExpression, Node, SourceFile, SyntaxKind } from "ts-morph";
import { HANDLERS } from "./types";

export function findFfImport(sf: SourceFile): { name: string; stmt: Node; esm: boolean; quote: string } | undefined {
  for (const stmt of sf.getStatements()) {
    if (Node.isVariableStatement(stmt)) {
      for (const d of stmt.getDeclarations()) {
        const init = d.getInitializer();
        if (init && isRequireOf(init, "ff") && Node.isIdentifier(d.getNameNode())) {
          return { name: d.getName(), stmt, esm: false, quote: quoteOf(init.getText()) };
        }
      }
    } else if (Node.isImportEqualsDeclaration(stmt)) {
      const ref = stmt.getModuleReference();
      if (Node.isExternalModuleReference(ref) && ref.getExpression()?.getText().slice(1, -1) === "ff") {
        return { name: stmt.getName(), stmt, esm: true, quote: quoteOf(ref.getText()) };
      }
    } else if (Node.isImportDeclaration(stmt) && stmt.getModuleSpecifierValue() === "ff") {
      const id = stmt.getDefaultImport() ?? stmt.getNamespaceImport();
      if (id) return { name: id.getText(), stmt, esm: true, quote: quoteOf(stmt.getModuleSpecifier().getText()) };
    }
  }
  return undefined;
}

export function isRequireOf(node: Node, mod: string): boolean {
  if (!Node.isCallExpression(node) || node.getExpression().getText() !== "require") return false;
  const [arg] = node.getArguments();
  return !!arg && Node.isStringLiteral(arg) && arg.getLiteralValue() === mod;
}

export const quoteOf = (s: string) => (s.includes("'") ? "'" : '"');

// `const f = ff(...).onSuccess(...)...` declarations, outermost first.
export function findChains(sf: SourceFile, ffName: string) {
  return sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).filter((d) => {
    const init = d.getInitializer();
    return init && unwrapChain(init, ffName);
  });
}

export function unwrapChain(expr: Node, ffName: string) {
  const handlers: { kind: string; call: CallExpression }[] = [];
  while (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isIdentifier(callee) && callee.getText() === ffName) {
      return { ffCall: expr, handlers: handlers.reverse() };
    }
    if (!Node.isPropertyAccessExpression(callee) || !HANDLERS[callee.getName()]) return undefined;
    handlers.push({ kind: HANDLERS[callee.getName()], call: expr });
    expr = callee.getExpression();
  }
  return undefined;
}
