// Moving a whole-function callbackify wrapper into a named fnAsync.

import { ArrowFunction, CallExpression, FunctionDeclaration, FunctionExpression, Node, Project, SourceFile, SyntaxKind } from "ts-morph";
import { Ctx, Edit, MARK } from "./types";
import { applyEdits, bindingNames, bodyIndent, gen, indentAt, isFn, isPropertyName, orig, refNames, render, templateRanges } from "./util";

// Where a function is only setup plus a generated wrapper,
//
//   const fn = function (a, next) { let x; callbackify(async () => {...})(cb(next)); };
//
// moves the body to `async function fnAsync(a) { let x; ... }` and leaves
// `callbackify(fnAsync)(a, cb(next))` in fn. Callers can then move to
// fnAsync one at a time; it is exported next to fn when fn is.
export function splitWrappers(project: Project, fileName: string, text: string): string {
  const sf = project.createSourceFile(fileName, text, { overwrite: true });
  const ctx = { text, templates: templateRanges(sf) } as Ctx;
  const taken = refNames(sf);
  const edits: Edit[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const plan = splitPlan(call, taken);
    if (!plan) continue;
    taken.add(plan.asyncName);
    edits.push(...splitEdits(ctx, sf, plan));
  }
  return applyEdits(text, edits);
}

export interface SplitPlan {
  fn: FunctionExpression | ArrowFunction | FunctionDeclaration;
  stmt: Node; // the top-level statement holding fn
  name: string;
  asyncName: string;
  params: string[]; // fn's params without the callback
  setup: Node[];
  wrapper: CallExpression; // callbackify(async () => {...})(cb)
  inner: ArrowFunction;
  esm: boolean;
}

export function splitPlan(call: CallExpression, taken: Set<string>): SplitPlan | undefined {
  const head = call.getExpression();
  if (!Node.isCallExpression(head) || head.getExpression().getText() !== "callbackify") return undefined;
  const [inner] = head.getArguments();
  if (!inner || !Node.isArrowFunction(inner) || !inner.getFullText().includes(MARK)) return undefined;
  if (call.getArguments().length !== 1 || inner.getParameters().length) return undefined;

  const exprStmt = call.getParent();
  const body = exprStmt?.getParent();
  const fn = body?.getParent();
  if (!exprStmt || !Node.isExpressionStatement(exprStmt) || !body || !Node.isBlock(body) || !fn) return undefined;
  if (!Node.isFunctionExpression(fn) && !Node.isArrowFunction(fn) && !Node.isFunctionDeclaration(fn)) return undefined;
  if (fn.isAsync() || (!Node.isArrowFunction(fn) && fn.isGenerator())) return undefined;
  const stmts = body.getStatements();
  if (stmts[stmts.length - 1] !== exprStmt) return undefined;

  // The callback is the last param, a plain name used only in the wrapper's
  // argument, as `next` or as `h(next)` with a callee that can't see fn's names.
  const params = fn.getParameters();
  if (!params.length || params.some((p) => !Node.isIdentifier(p.getNameNode()) || p.getInitializer() || p.isRestParameter() || p.getTypeNode())) return undefined;
  const cbName = params[params.length - 1].getName();
  const cbArg = call.getArguments()[0];
  const local = new Set(params.map((p) => p.getName()));
  const isCb = (n: Node) => Node.isIdentifier(n) && n.getText() === cbName;
  if (!isCb(cbArg)) {
    if (!Node.isCallExpression(cbArg) || cbArg.getArguments().length !== 1 || !isCb(cbArg.getArguments()[0])) return undefined;
    const callee = cbArg.getExpression();
    if (!Node.isIdentifier(callee) && !Node.isPropertyAccessExpression(callee)) return undefined;
    if ([...refNames(callee)].some((n) => local.has(n))) return undefined;
  }
  // Uses of the callback, not counting nested functions with their own
  // param of the same name.
  const cbParam = params[params.length - 1].getNameNode();
  const shadows = (id: Node) =>
    id.getAncestors().some((a) => a !== fn && isFn(a) && (a as ArrowFunction).getParameters().some((p) => bindingNames(p.getNameNode()).includes(cbName)));
  const cbUses = fn
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((id) => id !== cbParam && id.getText() === cbName && !isPropertyName(id) && !shadows(id));
  if (cbUses.length !== 1) return undefined;

  // Setup runs synchronously in both shapes, but a throw from it would now
  // go to the callback instead of the caller: only move code that can't throw.
  const setup = stmts.slice(0, -1);
  if (!setup.every(cantThrow)) return undefined;

  // `this` and `arguments` would mean something else in the new function.
  let ownThis = false;
  fn.forEachDescendant((d, walk) => {
    if ((Node.isFunctionExpression(d) || Node.isFunctionDeclaration(d) || Node.isMethodDeclaration(d)) && d !== fn) return walk.skip();
    if (Node.isThisExpression(d) || (Node.isIdentifier(d) && d.getText() === "arguments")) ownThis = true;
  });
  if (ownThis) return undefined;

  const where = bindingOf(fn);
  if (!where) return undefined;
  const asyncName = where.name + "Async";
  if (taken.has(asyncName)) return undefined;
  return {
    fn,
    stmt: where.stmt,
    name: where.name,
    asyncName,
    params: params.slice(0, -1).map((p) => p.getName()),
    setup,
    wrapper: call,
    inner,
    esm: where.esm,
  };
}

// `const name = function`, `module.exports.name = function` or
// `[export] function name`, at the top level of the file.
export function bindingOf(fn: Node): { name: string; stmt: Node; esm: boolean } | undefined {
  if (Node.isFunctionDeclaration(fn)) {
    const name = fn.getName();
    return name && Node.isSourceFile(fn.getParent()) ? { name, stmt: fn, esm: fn.isExported() } : undefined;
  }
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode())) {
    const stmt = parent.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    if (!stmt || !Node.isSourceFile(stmt.getParent()) || stmt.getDeclarations().length !== 1) return undefined;
    return { name: parent.getName(), stmt, esm: stmt.isExported() };
  }
  if (parent && Node.isBinaryExpression(parent) && parent.getRight() === fn) {
    const m = /^module\.exports\.([A-Za-z_$][\w$]*)$/.exec(parent.getLeft().getText());
    const stmt = parent.getParent();
    if (m && stmt && Node.isExpressionStatement(stmt) && Node.isSourceFile(stmt.getParent())) return { name: m[1], stmt, esm: false };
  }
  return undefined;
}

// Declarations whose initializers only build values: literals, names,
// arrays, objects, functions.
export function cantThrow(stmt: Node): boolean {
  if (!Node.isVariableStatement(stmt)) return false;
  const safe = (n: Node): boolean => {
    if (Node.isLiteralExpression(n) || Node.isIdentifier(n) || Node.isFunctionExpression(n) || Node.isArrowFunction(n)) return true;
    const k = n.getKind();
    if (k === SyntaxKind.TrueKeyword || k === SyntaxKind.FalseKeyword || k === SyntaxKind.NullKeyword) return true;
    if (Node.isArrayLiteralExpression(n)) return n.getElements().every(safe);
    if (Node.isObjectLiteralExpression(n)) {
      return n.getProperties().every((p) => (Node.isPropertyAssignment(p) && !Node.isComputedPropertyName(p.getNameNode()) && safe(p.getInitializerOrThrow())) || Node.isShorthandPropertyAssignment(p));
    }
    return false;
  };
  return stmt.getDeclarations().every((d) => Node.isIdentifier(d.getNameNode()) && (!d.getInitializer() || safe(d.getInitializerOrThrow())));
}

export function splitEdits(ctx: Ctx, sf: SourceFile, plan: SplitPlan): Edit[] {
  const { fn, stmt, name, asyncName, params, setup, wrapper, inner } = plan;
  const text = ctx.text;
  const stmtIndent = indentAt(text, stmt.getStart());
  const body = fn.getBody() as Node;
  const bodyIndent = indentAt(text, wrapper.getStart());
  const unit = bodyIndent.slice(stmtIndent.length) || "  ";
  const target = stmtIndent + unit;

  const lines: string[] = [];
  for (const s of setup) {
    const pieces = [orig(ctx, s.getStart(true), s.getEnd())];
    lines.push(target + render(ctx, pieces, bodyIndent.length - target.length));
  }
  const innerBody = inner.getBody() as Node;
  if (Node.isBlock(innerBody)) {
    const first = innerBody.getStatements()[0];
    const from = first ? first.getStart(true) : innerBody.getStart() + 1;
    let end = innerBody.getEnd() - 1;
    while (end > from && /\s/.test(text[end - 1])) end--;
    const innerIndent = first ? indentAt(text, first.getStart(true)) : target;
    // Keep a blank line between the setup and the chain body.
    const gap = setup.length && /\n[ \t]*\n/.test(text.slice(setup[setup.length - 1].getEnd(), wrapper.getStart()));
    if (end > from) lines.push((gap ? "\n" : "") + target + render(ctx, [orig(ctx, from, end)], innerIndent.length - target.length));
  }

  const exp = plan.esm ? "export " : "";
  const decl = `${exp}async function ${asyncName}(${params.join(", ")}) {\n${lines.join("\n")}\n${stmtIndent}}`;
  const cbArg = wrapper.getArguments()[0].getText();
  const call = `callbackify(${asyncName})(${[...params, cbArg].join(", ")});`;

  const edits: Edit[] = [
    { start: body.getStart() + 1, end: body.getEnd() - 1, pieces: [gen(`\n${bodyIndent}${call}\n${stmtIndent}`)] },
    { start: stmt.getEnd(), end: stmt.getEnd(), pieces: [gen(`\n\n${decl}`)] },
  ];

  // Export the async version next to the callback one.
  if (!plan.esm) {
    const viaStmt = Node.isExpressionStatement(stmt);
    const exportStmt = viaStmt
      ? stmt
      : sf.getStatements().find((s) => Node.isExpressionStatement(s) && /^module\.exports\.([\w$]+)\s*=\s*([\w$]+);?$/.exec(s.getText())?.slice(1).every((n) => n === name));
    if (exportStmt === stmt) {
      edits[1].pieces.push(gen(`\nmodule.exports.${asyncName} = ${asyncName};`));
    } else if (exportStmt) {
      edits.push({ start: exportStmt.getEnd(), end: exportStmt.getEnd(), pieces: [gen(`\nmodule.exports.${asyncName} = ${asyncName};`)] });
    } else {
      const shorthand = sf
        .getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)
        .find((p) => p.getName() === name && /^module\.exports\s*=/.test(p.getParentOrThrow().getParentOrThrow().getText()));
      if (shorthand) {
        edits.push({ start: shorthand.getEnd(), end: shorthand.getEnd(), pieces: [gen(`,\n${indentAt(text, shorthand.getStart())}${asyncName}`)] });
      }
    }
  }
  return edits;
}
