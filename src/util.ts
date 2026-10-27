// Text and AST helpers.

import { Node, SourceFile, SyntaxKind } from "ts-morph";
import { Ctx, Edit, Piece, Step } from "./types";

export const gen = (text: string): Piece => ({ text });

export const orig = (ctx: Ctx, start: number, end: number): Piece => ({ text: ctx.text.slice(start, end), pos: start });

export function copyWithEdits(ctx: Ctx, start: number, end: number, edits: Edit[]): Piece[] {
  const out: Piece[] = [];
  let at = start;
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    if (e.start < at || e.end > end) continue;
    out.push(orig(ctx, at, e.start), ...e.pieces);
    at = e.end;
  }
  out.push(orig(ctx, at, end));
  return out;
}

export function joinPieces(lists: Piece[][]): Piece[] {
  return lists.flatMap((l, i) => (i ? [gen(", "), ...l] : l));
}

// Concatenates pieces, shifting every original line left by `delta` columns
// (right if negative). Lines inside a multi-line template literal keep
// their indentation, since it is part of the string.
export function render(ctx: Ctx, pieces: Piece[], delta: number): string {
  let out = "";
  for (const p of pieces) {
    if (p.pos === undefined) {
      out += p.text;
      continue;
    }
    const lines = p.text.split("\n");
    out += lines[0];
    let off = p.pos + lines[0].length + 1;
    for (const line of lines.slice(1)) {
      const inTemplate = ctx.templates.some(([s, e]) => off > s && off < e);
      out += "\n" + (inTemplate ? line : shift(line, delta));
      off += line.length + 1;
    }
  }
  return out;
}

export function shift(line: string, delta: number): string {
  if (delta < 0) return line.trim() ? " ".repeat(-delta) + line : line;
  let i = 0;
  while (i < delta && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

export function templateRanges(sf: SourceFile): [number, number][] {
  return sf
    .getDescendants()
    .filter((n) => Node.isNoSubstitutionTemplateLiteral(n) || Node.isTemplateExpression(n))
    .filter((n) => n.getText().includes("\n"))
    .map((n) => [n.getStart(), n.getEnd()]);
}

export function applyEdits(text: string, edits: Edit[]): string {
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, e.start) + e.pieces.map((p) => p.text).join("") + text.slice(e.end);
  }
  return text;
}

export function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

export function bodyIndent(ctx: Ctx, step: Step): string {
  const body = step.fn.getBody()!;
  if (!Node.isBlock(body)) return indentAt(ctx.text, body.getStart());
  let i = body.getStart() + 1;
  while (i < body.getEnd() - 1 && /\s/.test(ctx.text[i])) i++;
  return indentAt(ctx.text, i);
}

export function bindingNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  return name.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((b) => {
    const n = b.getNameNode();
    return Node.isIdentifier(n) ? [n.getText()] : [];
  });
}

export function isPropertyName(id: Node): boolean {
  const p = id.getParent();
  if (!p) return false;
  if (Node.isPropertyAccessExpression(p)) return p.getNameNode() === id;
  if (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isPropertyDeclaration(p) || Node.isPropertySignature(p)) {
    return p.getNameNode() === id;
  }
  if (Node.isBindingElement(p)) return p.getPropertyNameNode() === id;
  return false;
}

export function refNames(node: Node): Set<string> {
  const out = new Set<string>();
  const visit = (d: Node) => {
    if (Node.isIdentifier(d) && !isPropertyName(d)) out.add(d.getText());
  };
  visit(node);
  node.forEachDescendant(visit);
  return out;
}

export function isAssigned(fn: Node, name: string): boolean {
  return fn.getDescendants().some((d) => {
    if (Node.isBinaryExpression(d)) {
      const k = d.getOperatorToken().getKind();
      return k >= SyntaxKind.FirstAssignment && k <= SyntaxKind.LastAssignment && d.getLeft().getText() === name;
    }
    if (Node.isPrefixUnaryExpression(d) || Node.isPostfixUnaryExpression(d)) {
      const k = d.getOperatorToken();
      return (k === SyntaxKind.PlusPlusToken || k === SyntaxKind.MinusMinusToken) && d.getOperand().getText() === name;
    }
    return false;
  });
}

export function isFn(n: Node): boolean {
  return Node.isFunctionLikeDeclaration(n) || Node.isFunctionExpression(n);
}
