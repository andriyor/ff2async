// Writing the async/await version of a chain.

import { CallExpression, Node } from "ts-morph";
import { Ctx, Edit, MARK, Param, Piece, Reg, Skip, SlotKind, Step } from "./types";
import { fMethod, namesFor, split } from "./analyze";
import { bodyIndent, copyWithEdits, gen, indentAt, isAssigned, joinPieces, orig, refNames, render } from "./util";

export interface Ending {
  head: string;
  tail: (stmtIndent: string) => Piece[];
}

export function endingFor(ctx: Ctx, handlers: { kind: string; call: CallExpression }[]): Ending {
  const kinds = handlers.map((h) => h.kind);
  if (new Set(kinds).size !== kinds.length) throw new Skip(handlers[0].call, "the same handler kind is attached twice");
  const arg = (kind: string) => handlers.find((h) => h.kind === kind)?.call.getArguments()[0];
  const handlerPieces = (node: Node, stmtIndent: string): Piece[] => {
    const delta = indentAt(ctx.text, node.getStart()).length - stmtIndent.length;
    return [{ text: render(ctx, [orig(ctx, node.getStart(), node.getEnd())], delta) }];
  };

  if (kinds.includes("onComplete")) {
    if (kinds.length > 1) throw new Skip(handlers[0].call, "onComplete together with onSuccess/onError");
    ctx.used.add("callbackify");
    return { head: `callbackify(${MARK}async () => {`, tail: (ind) => [gen("})("), ...handlerPieces(arg("onComplete")!, ind), gen(");")] };
  }
  const s = arg("onSuccess");
  const e = arg("onError");
  return {
    head: "(async () => {",
    tail: (ind) => {
      if (s && e) return [gen("})().then("), ...handlerPieces(s, ind), gen(", "), ...handlerPieces(e, ind), gen(");")];
      if (s) return [gen("})().then("), ...handlerPieces(s, ind), gen(");")];
      if (e) return [gen("})().catch("), ...handlerPieces(e, ind), gen(");")];
      return [gen("})();")];
    },
  };
}

export function emitChain(ctx: Ctx, stmt: Node, steps: Step[], aliases: Set<Param>, ending: Ending): Piece[] {
  const stmtIndent = indentAt(ctx.text, stmt.getStart());
  const first = steps[0];
  const unit = Math.max(bodyIndent(ctx, first).length - indentAt(ctx.text, first.fn.getStart()).length, 0) || 2;
  const target = stmtIndent + " ".repeat(unit);

  const parts: string[] = [];
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    const delta = bodyIndent(ctx, step).length - target.length;
    for (const c of step.fn.getLeadingCommentRanges()) {
      const d = indentAt(ctx.text, c.getPos()).length - target.length;
      parts.push(render(ctx, [orig(ctx, c.getPos(), c.getEnd())], d));
    }
    const edits = stepEdits(ctx, step, namesFor(steps, i), aliases, next, !next, target);
    const body = step.fn.getBody()!;
    let start = Node.isBlock(body) ? body.getStart() + 1 : body.getStart();
    let end = Node.isBlock(body) ? body.getEnd() - 1 : body.getEnd();
    while (start < end && /\s/.test(ctx.text[start])) start++;
    while (end > start && /\s/.test(ctx.text[end - 1])) end--;
    const pieces = copyWithEdits(ctx, start, end, edits);
    if (!Node.isBlock(body) && !edits.length) pieces.push(gen(";"));
    const out = render(ctx, pieces, delta);
    if (out.trim()) parts.push(out);
  });

  return [gen(ending.head + "\n" + parts.map((p) => target + p).join("\n") + "\n" + stmtIndent), ...ending.tail(stmtIndent)];
}

export function stepEdits(
  ctx: Ctx,
  step: Step,
  names: (Param | undefined)[],
  aliases: Set<Param>,
  next: Step | undefined,
  isLast: boolean,
  target: string
): Edit[] {
  const edits: Edit[] = [];
  const range = (n: Node) => ({ start: n.getStart(), end: n.getEnd() });

  for (const t of step.terminals) {
    const parent = t.getParentOrThrow();
    const node = Node.isReturnStatement(parent) || Node.isExpressionStatement(parent) ? parent : t;
    const [arg] = t.getArguments();
    const pieces =
      fMethod(ctx, t) === "fail"
        ? [gen("throw "), orig(ctx, arg.getStart(), arg.getEnd()), gen(";")]
        : arg
          ? [gen("return "), orig(ctx, arg.getStart(), arg.getEnd()), gen(";")]
          : [gen("return;")];
    edits.push({ ...range(node), pieces });
  }

  if (step.branched) return [...edits, ...branchedEdits(ctx, step, names, next, isLast, target)];

  // Value index of each registration in the next step's args.
  const offset = new Map<Reg, number>();
  step.regs.reduce((k, r) => (offset.set(r, k), k + r.n), 0);
  const assigned = (p: Param) => !!next && p.names.some((n) => isAssigned(next.fn, n));

  if (isLast) {
    const tail = step.regs;
    if (!tail.length) return edits;
    const n = tail.reduce((s, r) => s + r.n, 0);
    const hosts = tail.filter((r) => r.host);
    let pieces: Piece[];
    if (!hosts.length) {
      pieces = n ? [gen("return "), ...valuePieces(ctx, tail[tail.length - 1]), gen(";")] : [];
      // ponytail: passes in a last step with no slot give no value worth keeping beyond the last one
      if (tail.some((r) => r.n && r !== tail[tail.length - 1])) throw new Skip(step.fn, "last step passes several values");
    } else if (tail.length === 1) {
      pieces = [gen(n ? "return " : "await "), ...promisePieces(ctx, tail[0]), gen(";")];
    } else {
      const idx = elements(ctx, tail, names, offset, aliases).findIndex((e) => e.n === 1);
      const all = [gen("Promise.all(["), ...joinPieces(elements(ctx, tail, names, offset, aliases).map((e) => e.pieces)), gen("])")];
      pieces = n ? [gen("return (await "), ...all, gen(`)[${idx}];`)] : [gen("await "), ...all, gen(";")];
    }
    edits.push({ start: tail[0].item.getStart(), end: tail[tail.length - 1].item.getEnd(), pieces: withComments(ctx, tail, pieces, target) });
    return edits;
  }

  const { before, tail } = split(step);
  for (const r of before) {
    const decls: Piece[][] = [];
    r.fCall.getArguments().forEach((a, j) => {
      const p = names[offset.get(r)! + j];
      if (p && aliases.has(p)) return;
      if (!p) {
        if (!Node.isIdentifier(a) && !Node.isLiteralExpression(a) && !Node.isPropertyAccessExpression(a)) {
          decls.push([orig(ctx, a.getStart(), a.getEnd())]);
        }
        return;
      }
      const kw = assigned(p) ? "let " : "const ";
      decls.push([gen(kw + p.text + (p.type ? `: ${p.type}` : "") + " = "), orig(ctx, a.getStart(), a.getEnd())]);
    });
    const pieces = decls.flatMap((d, k) => [...(k ? [gen(";\n" + target)] : []), ...d]);
    edits.push({ ...range(r.item), pieces: pieces.length ? [...pieces, gen(";")] : [] });
  }
  if (!tail.length) return edits;

  const els = elements(ctx, tail, names, offset, aliases);
  const bindings = els.map((e) => bindingFor(e.names));
  const anyName = bindings.some((b) => b.text);
  const kw = els.some((e) => e.names.some((p) => p && assigned(p))) ? "let " : "const ";
  let pieces: Piece[];
  if (els.length === 1) {
    const b = bindings[0];
    pieces = b.text
      ? [gen(kw + b.text + (b.type ? `: ${b.type}` : "") + " = await "), ...els[0].pieces, gen(";")]
      : [gen("await "), ...els[0].pieces, gen(";")];
  } else {
    let last = bindings.length;
    while (last > 0 && !bindings[last - 1].text) last--;
    const pattern = "[" + bindings.slice(0, last).map((b) => b.text).join(", ") + "]";
    const typed = bindings.slice(0, last).some((b) => b.type);
    const type = typed ? ": [" + bindings.slice(0, last).map((b) => b.type ?? "any").join(", ") + "]" : "";
    const all = [gen("Promise.all(["), ...joinPieces(els.map((e) => e.pieces)), gen("])")];
    pieces = anyName ? [gen(kw + pattern + type + " = await "), ...all, gen(";")] : [gen("await "), ...all, gen(";")];
  }
  edits.push({ start: tail[0].item.getStart(), end: tail[tail.length - 1].item.getEnd(), pieces: withComments(ctx, tail, pieces, target) });
  return edits;
}

// A step with slots in if/else: each slot or pass stores its promise or
// value at its position in an array, and the step ends by awaiting all of
// it. A position no branch filled is a hole, which Promise.all gives as
// undefined, as ff did.
export function branchedEdits(
  ctx: Ctx,
  step: Step,
  names: (Param | undefined)[],
  next: Step | undefined,
  isLast: boolean,
  target: string
): Edit[] {
  const arr = freshName(ctx, "pending");
  const edits: Edit[] = step.regs.map((r) => {
    const set = (k: number, value: Piece[]) => [gen(`${arr}[${k}] = `), ...value, gen(";")];
    const pieces =
      r.kind === "pass"
        ? r.fCall.getArguments().flatMap((a, j) => [...(j ? [gen(" ")] : []), ...set(r.pos! + j, [orig(ctx, a.getStart(), a.getEnd())])])
        : set(r.pos!, promisePieces(ctx, r));
    return { start: r.item.getStart(), end: r.item.getEnd(), pieces };
  });

  const items = step.items;
  const first = items[0];
  const last = items[items.length - 1];
  const decl = `const ${arr}${ctx.ts ? ": any[]" : ""} = [];\n${target}`;
  let end: string;
  if (isLast) {
    end = step.valueCount ? `return (await Promise.all(${arr}))[0];` : `await Promise.all(${arr});`;
  } else {
    let offset = 0;
    const bindings = step.shape.map((n) => {
      const b = bindingFor(names.slice(offset, offset + n));
      offset += n;
      return b;
    });
    let k = bindings.length;
    while (k > 0 && !bindings[k - 1].text) k--;
    const used = bindings.slice(0, k);
    const assigned = names.some((p) => p && next && p.names.some((n) => isAssigned(next.fn, n)));
    const type = ctx.ts && used.some((b) => b.type) ? ": [" + used.map((b) => b.type ?? "any").join(", ") + "]" : "";
    end = k
      ? `${assigned ? "let" : "const"} [${used.map((b) => b.text).join(", ")}]${type} = await Promise.all(${arr});`
      : `await Promise.all(${arr});`;
  }
  // First, so it comes before an edit that starts at the same place.
  edits.unshift({ start: first.getStart(), end: first.getStart(), pieces: [gen(decl)] });
  edits.push({ start: last.getEnd(), end: last.getEnd(), pieces: [gen(`\n${target}${end}`)] });
  return edits;
}

// A name not used in the file, nor already handed out in this pass.
export function freshName(ctx: Ctx, base: string): string {
  const taken = refNames(ctx.sf);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : base + i;
    if (!taken.has(name) && !ctx.fresh.has(name)) {
      ctx.fresh.add(name);
      return name;
    }
  }
}

// Comments between the tail statements would be lost; put them first.
export function withComments(ctx: Ctx, tail: Reg[], pieces: Piece[], target: string): Piece[] {
  const comments = tail.slice(1).flatMap((r) => r.item.getLeadingCommentRanges().map((c) => c.getText()));
  return [...comments.map((c) => gen(c + "\n" + target)), ...pieces];
}

// One Promise.all element per value source: a slot's promise, or one per
// pass argument, with the next step's params it fills.
// A pass into a param of the same name (an alias) needs no element.
export function elements(ctx: Ctx, regs: Reg[], names: (Param | undefined)[], offset: Map<Reg, number>, aliases: Set<Param>) {
  return regs.flatMap((r) => {
    const k = offset.get(r)!;
    if (r.kind === "pass") {
      return r.fCall
        .getArguments()
        .map((a, j) => ({ n: 1, pieces: [orig(ctx, a.getStart(), a.getEnd())], names: [names[k + j]] }))
        .filter((e) => !(e.names[0] && aliases.has(e.names[0])));
    }
    return [{ n: r.n, pieces: promisePieces(ctx, r), names: names.slice(k, k + r.n) }];
  });
}

export function bindingFor(names: (Param | undefined)[]): { text: string; type?: string } {
  if (names.length === 0) return { text: "" };
  if (names.length === 1) return { text: names[0]?.text ?? "", type: names[0]?.type };
  if (names.every((p) => !p)) return { text: "" };
  let last = names.length;
  while (!names[last - 1]) last--;
  const typed = names.some((p) => p?.type);
  return {
    text: "[" + names.slice(0, last).map((p) => p?.text ?? "").join(", ") + "]",
    type: typed ? "[" + names.slice(0, last).map((p) => p?.type ?? "any").join(", ") + "]" : undefined,
  };
}

export function valuePieces(ctx: Ctx, r: Reg): Piece[] {
  const [a] = r.fCall.getArguments();
  return [orig(ctx, a.getStart(), a.getEnd())];
}

// The promise for a slot: promisify(fn)(args) where that keeps `this` and
// argument order, else a hand-written new Promise.
export function promisePieces(ctx: Ctx, r: Reg): Piece[] {
  const host = r.host!;
  const args = host.getArguments();
  const callee = host.getExpression();
  const fArg = args[r.argIndex!];
  const isLastArg = r.argIndex === args.length - 1;
  const simpleObj = (n: Node): boolean =>
    Node.isIdentifier(n) || Node.isThisExpression(n) || (Node.isPropertyAccessExpression(n) && !n.hasQuestionDotToken() && simpleObj(n.getExpression()));
  const canPromisify =
    (r.kind === "slot" || r.kind === "wait") &&
    isLastArg &&
    !host.getTypeArguments().length &&
    !host.hasQuestionDotToken() &&
    (Node.isIdentifier(callee) || (Node.isPropertyAccessExpression(callee) && !callee.hasQuestionDotToken() && simpleObj(callee.getExpression())));

  const calleePiece = orig(ctx, callee.getStart(), callee.getEnd());
  if (canPromisify) {
    ctx.used.add("promisify");
    const fn: Piece[] = Node.isPropertyAccessExpression(callee)
      ? [gen("promisify("), calleePiece, gen(".bind("), orig(ctx, callee.getExpression().getStart(), callee.getExpression().getEnd()), gen("))")]
      : [gen("promisify("), calleePiece, gen(")")];
    // The original argument list, without the slot.
    const cut = r.argIndex! > 0 ? args[r.argIndex! - 1].getEnd() : fArg.getStart();
    return [...fn, ...copyWithEdits(ctx, callee.getEnd(), host.getEnd(), [{ start: cut, end: fArg.getEnd(), pieces: [] }])];
  }

  const t = ctx.ts;
  const any = (name: string) => (t ? `${name}: any` : name);
  const cb: Record<SlotKind, string> = {
    slot: `(${any("err")}, ${any("value")}) => (err ? reject(err) : resolve(value))`,
    wait: `(${any("err")}) => (err ? reject(err) : resolve())`,
    slotMulti: `(${any("err")}, ...${t ? "values: any[]" : "values"}) => (err ? reject(err) : resolve(values))`,
    slotPlain: r.n === 1 ? `(${any("value")}) => resolve(value)` : `(...${t ? "values: any[]" : "values"}) => resolve(values)`,
    waitPlain: `() => resolve()`,
  };
  const kind = r.kind as SlotKind;
  const plain = kind === "slotPlain" || kind === "waitPlain";
  const head = `new Promise${t ? "<any>" : ""}((${plain ? "resolve" : "resolve, reject"}) => `;
  return [gen(head), calleePiece, ...copyWithEdits(ctx, callee.getEnd(), host.getEnd(), [{ start: fArg.getStart(), end: fArg.getEnd(), pieces: [gen(cb[kind])] }]), gen(")")];
}
