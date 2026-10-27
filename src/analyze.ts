// Checking that a chain is straight-line and safe to convert.

import { CallExpression, Node, SyntaxKind } from "ts-morph";
import { Ctx, Param, Reg, SLOT_KINDS, Skip, SlotKind, Step } from "./types";
import { bindingNames, isAssigned, isFn, isPropertyName, refNames } from "./util";

// In ff, step 1 starts on the next tick; the async version starts it right
// away. That is only safe when nothing runs after the chain is set up.
export function checkNothingRunsAfter(ctx: Ctx, stmt: Node) {
  let node: Node = stmt;
  for (;;) {
    const parent = node.getParentOrThrow();
    if (Node.isSourceFile(parent) || Node.isBlock(parent) || Node.isCaseClause(parent) || Node.isDefaultClause(parent)) {
      for (const next of node.getNextSiblings()) {
        const harmless =
          Node.isFunctionDeclaration(next) ||
          Node.isEmptyStatement(next) ||
          Node.isBreakStatement(next) ||
          (Node.isReturnStatement(next) && !next.getExpression());
        if (!harmless) throw new Skip(next, "code runs after the chain is set up; step 1 would now run before it");
        if (refNames(next).has(ctx.fName)) throw new Skip(next, "the chain variable is used after the chain");
      }
    }
    if (Node.isSourceFile(parent) || isFn(parent)) return;
    if (Node.isIterationStatement(parent)) throw new Skip(parent, "chain is set up inside a loop");
    if (Node.isTryStatement(parent) && parent.getFinallyBlock()) throw new Skip(parent, "chain is inside try/finally");
    node = parent;
  }
}

export function analyzeStep(ctx: Ctx, fn: Node): Step {
  if (!Node.isFunctionExpression(fn) && !Node.isArrowFunction(fn)) {
    throw new Skip(fn, "step is not an inline function (or ff got a context object)");
  }
  if (fn.isAsync() || (Node.isFunctionExpression(fn) && fn.isGenerator())) throw new Skip(fn, "async or generator step");
  const body = fn.getBody();
  const items: Node[] = Node.isBlock(body) ? body.getStatements() : [body];

  const params: Param[] = fn.getParameters().map((p) => {
    if (p.getInitializer() || p.isRestParameter()) throw new Skip(p, "step parameter has a default or is a rest parameter");
    return { node: p, text: p.getNameNode().getText(), names: bindingNames(p.getNameNode()), type: p.getTypeNode()?.getText() };
  });

  // Only the step's own function counts: `this`, `arguments` and `return`
  // inside a nested function are fine.
  const own = (n: Node) => n.getFirstAncestor((a) => isFn(a)) === fn;
  const ownNonArrow = (n: Node) => n.getFirstAncestor((a) => isFn(a) && !Node.isArrowFunction(a)) === fn;

  if (Node.isFunctionExpression(fn)) {
    const name = fn.getName();
    fn.forEachDescendant((d) => {
      if ((Node.isThisExpression(d) || (Node.isIdentifier(d) && d.getText() === "arguments")) && ownNonArrow(d)) {
        throw new Skip(d, "step uses `this` or `arguments`");
      }
      if (name && Node.isIdentifier(d) && d.getText() === name) throw new Skip(d, "step refers to its own name");
    });
  }

  const terminals: CallExpression[] = [];
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const m = fMethod(ctx, call);
    if (m !== "succeed" && m !== "fail") continue;
    const parent = call.getParentOrThrow();
    const atEnd = parent === fn || (Node.isExpressionStatement(parent) && endsStep(fn, parent));
    const returned = Node.isReturnStatement(parent) && own(parent);
    if (!atEnd && !returned) {
      throw new Skip(call, `f.${m}() without return, or in a nested callback; code after it still ran in ff`);
    }
    if (m === "succeed" && call.getArguments().length > 1) throw new Skip(call, "f.succeed() with several values");
    if (m === "fail" && call.getArguments().length !== 1) throw new Skip(call, "f.fail() needs exactly one error");
    terminals.push(call);
  }

  const { regs, shape } = walkStep(ctx, items, terminals);

  // Every use of `f` must be one of the calls above.
  const accounted = new Set<Node>([...regs.map((r) => r.fCall), ...terminals]);
  fn.forEachDescendant((d) => {
    if (!Node.isIdentifier(d) || d.getText() !== ctx.fName || isPropertyName(d)) return;
    const pa = d.getParent();
    const call = pa && Node.isPropertyAccessExpression(pa) ? pa.getParent() : undefined;
    if (call && !accounted.has(call) && Node.isExpressionStatement(call.getParent()) && SLOT_KINDS.has(fMethod(ctx, call)!)) {
      throw new Skip(d, `${call.getText()} is never called back, so the chain never ends in ff`);
    }
    if (!call || !accounted.has(call)) {
      throw new Skip(d, `${ctx.fName} is used in a loop, a nested callback or as a value`);
    }
  });

  fn.forEachDescendant((d) => {
    if (Node.isReturnStatement(d) && own(d) && !terminals.some((t) => t.getParent() === d)) {
      throw new Skip(d, "plain `return` in a step; it only ended that step in ff");
    }
    if (Node.isIdentifier(d) && (d.getText() === "callbackify" || d.getText() === "promisify") && !isPropertyName(d)) {
      throw new Skip(d, `step already uses the name ${d.getText()}`);
    }
  });

  const branched = regs.some((r) => !items.includes(r.item));
  return { fn, items, params, regs, terminals, shape, valueCount: shape.reduce((a, b) => a + b, 0), branched };
}

// True when nothing in the step runs after `stmt`: it is last in its block,
// and so is each if/else around it.
export function endsStep(fn: Step["fn"], stmt: Node): boolean {
  let node = stmt;
  while (node !== fn.getBody()) {
    const parent = node.getParentOrThrow();
    if (Node.isBlock(parent)) {
      const stmts = parent.getStatements();
      if (stmts[stmts.length - 1] !== node) return false;
    } else if (!Node.isIfStatement(parent)) {
      return false;
    }
    node = parent;
  }
  return true;
}

// Walks a step in order, through if/else, and gives each registration its
// position in the next step's args. In ff those args are in the order the
// slots were made, so a slot in a branch is fine as long as every branch
// that registers gives the same values in the same positions; a branch that
// gives fewer can only be followed by nothing that gives a value.
// Rejects code, succeed or fail after a slot on the same path: in ff they
// dropped the slot's result, after an await they would leave its error
// unhandled.
export function walkStep(ctx: Ctx, items: Node[], terminals: CallExpression[]) {
  interface State {
    started: boolean; // a slot is pending on this path
    shape: number[]; // values given at each position so far
    shifted: boolean; // an earlier branch gave fewer values than another
    ended: boolean; // the path ended with succeed, fail or throw
  }
  const regs: Reg[] = [];
  const termStmts = new Set<Node>(terminals.map((t) => t.getParentOrThrow()));
  const walk = (stmts: Node[], st: State) => {
    for (const s of stmts) {
      const reg = classify(ctx, s);
      if (reg) {
        if (reg.n) {
          if (st.shifted) throw new Skip(s, "a value after a branch that gives fewer values; the next step's args would shift");
          reg.pos = st.shape.length;
          // A pass gives one position per value, a slot one for all of them.
          if (reg.kind === "pass") st.shape.push(...Array(reg.n).fill(1));
          else st.shape.push(reg.n);
        }
        if (reg.host) st.started = true;
        regs.push(reg);
      } else if (termStmts.has(s) || Node.isThrowStatement(s)) {
        if (st.started) throw new Skip(s, "succeed, fail or throw after a slot on the same path; ff dropped the slot's result");
        st.ended = true;
      } else if (Node.isIfStatement(s) && refNames(s).has(ctx.fName)) {
        // After a slot, a throw in the condition would leave that slot's
        // rejection unhandled; only allow conditions that can't call anything.
        const cond = s.getExpression();
        if (st.started && (cond.getFirstDescendant((d) => Node.isCallExpression(d) || Node.isNewExpression(d) || Node.isTaggedTemplateExpression(d)) || Node.isCallExpression(cond))) {
          throw new Skip(s, "a condition that calls a function after a slot in the same step");
        }
        const branches = [s.getThenStatement(), s.getElseStatement()].map((b) => {
          const out: State = { started: false, shape: [...st.shape], shifted: st.shifted, ended: false };
          if (b) walk(Node.isBlock(b) ? b.getStatements() : [b], out);
          return out;
        });
        // A branch that ended doesn't reach the code after the if.
        const going = branches.filter((b) => !b.ended);
        if (!going.length) {
          st.ended = true;
          continue;
        }
        const longest = going.reduce((a, b) => (b.shape.length > a.shape.length ? b : a)).shape;
        for (const b of going) {
          if (b.shape.some((n, i) => n !== longest[i])) throw new Skip(s, "branches give different values in the same position");
        }
        st.shape = longest;
        st.started = going.some((b) => b.started);
        st.shifted = going.some((b) => b.shifted || b.shape.length !== longest.length);
      } else if (st.ended) {
        throw new Skip(s, "code after succeed, fail or throw");
      } else if (st.started) {
        throw new Skip(s, "code after a slot in the same step");
      }
    }
  };
  const st: State = { started: false, shape: [], shifted: false, ended: false };
  walk(items, st);
  // Waits give no value; they go after the values in the promise array.
  let k = st.shape.length;
  for (const r of regs) if (!r.n && r.host) r.pos = k++;
  return { regs, shape: st.shape };
}

export function fMethod(ctx: Ctx, call: Node): string | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getExpression().getText() !== ctx.fName) return undefined;
  return callee.getName();
}

// A top-level `f.pass(...)`, or `host(..., f.slot())` with the slot as one argument.
export function classify(ctx: Ctx, item: Node): Reg | undefined {
  const expr = Node.isExpressionStatement(item) ? item.getExpression() : item;
  if (!Node.isCallExpression(expr)) return undefined;
  const m = fMethod(ctx, expr);
  if (m === "pass" || (m === "slot" && expr.getArguments().length)) {
    return { item, fCall: expr, kind: "pass", n: expr.getArguments().length };
  }
  if (m) return undefined;
  const args = expr.getArguments();
  const idx = args.findIndex((a) => fMethod(ctx, a) !== undefined);
  if (idx < 0) return undefined;
  const fCall = args[idx] as CallExpression;
  const kind = fMethod(ctx, fCall)!;
  if (!SLOT_KINDS.has(kind)) return undefined;
  const fArgs = fCall.getArguments();
  let n = kind === "slot" ? 1 : 0;
  if (kind === "slot" && fArgs.length) return undefined;
  if (kind === "slotMulti" || kind === "slotPlain") {
    const count = fArgs.length ? Number(fArgs[0].getText()) : kind === "slotPlain" ? 1 : NaN;
    if (!Number.isInteger(count) || count < 1) throw new Skip(fCall, `f.${kind}() needs a literal count`);
    n = count;
  }
  const k = kind === "slotMulti" && n === 1 ? "slot" : kind;
  const hostRefs = refNames(expr.getExpression());
  args.forEach((a, i) => i !== idx && refNames(a).forEach((r) => hostRefs.add(r)));
  if (hostRefs.has("resolve") || hostRefs.has("reject")) throw new Skip(expr, "call uses the names resolve/reject");
  return { item, fCall, kind: k as SlotKind, n, host: expr, argIndex: idx };
}

// Splits a step's registrations into passes that become `const`s in place
// and a tail of slots that is awaited at the end of the step.
export function split(step: Step) {
  let start = step.items.length;
  while (start > 0 && step.regs.some((r) => r.item === step.items[start - 1])) start--;
  const tail = step.regs.filter((r) => step.items.indexOf(r.item) >= start);
  const before = step.regs.filter((r) => !tail.includes(r));
  for (const r of before) {
    if (r.kind !== "pass") throw new Skip(r.item, "slot is followed by other code in the same step");
  }
  // Leading passes of the tail run before any slot: same as a const in place.
  while (tail.length && tail[0].kind === "pass") before.push(tail.shift()!);
  return { before, tail };
}

export function checkArgCounts(steps: Step[]) {
  steps.forEach((s, i) => {
    const n = s.valueCount;
    const next = steps[i + 1];
    if (next && next.params.length > n) {
      throw new Skip(next.fn, `step ${i + 2} takes ${next.params.length} args but step ${i + 1} gives ${n}`);
    }
    if (!next) {
      if (n > 1) throw new Skip(s.fn, "last step gives several values to the handlers");
      if (!s.branched && s.regs.some((r) => step0Index(s, r) < tailStart(s))) {
        throw new Skip(s.fn, "last step passes a value before other code");
      }
    }
  });
}

export const step0Index = (s: Step, r: Reg) => s.items.indexOf(r.item);

export function tailStart(s: Step) {
  let start = s.items.length;
  while (start > 0 && s.regs.some((r) => r.item === s.items[start - 1])) start--;
  return start;
}

// The values each step's registrations give, as names of the next step's
// params (undefined where the next step doesn't name it).
export function namesFor(steps: Step[], i: number): (Param | undefined)[] {
  const n = steps[i].valueCount;
  const params = steps[i + 1]?.params ?? [];
  return Array.from({ length: n }, (_, k) => params[k]);
}

// `f.pass(x)` into a param also named `x` needs no declaration: the step
// after it can use `x` directly.
export function findAliases(steps: Step[]): Set<Param> {
  const aliases = new Set<Param>();
  steps.forEach((s, i) => {
    // In a branch, the pass may not run; the name must be declared.
    if (s.branched) return;
    const names = namesFor(steps, i);
    let k = 0;
    for (const r of s.regs) {
      if (r.kind === "pass") {
        r.fCall.getArguments().forEach((a, j) => {
          const p = names[k + j];
          if (p && Node.isIdentifier(a) && a.getText() === p.text && !isAssigned(steps[i + 1].fn, p.text) && !isAssigned(s.fn, p.text)) {
            aliases.add(p);
          }
        });
      }
      k += r.n;
    }
  });
  return aliases;
}

// Flattening the steps into one function puts their names in one scope.
// Skip when a name declared in one step is also declared or used in another.
export function checkScopes(steps: Step[], aliases: Set<Param>) {
  const declared = steps.map((s) => {
    const out = new Set<string>();
    s.params.filter((p) => !aliases.has(p)).forEach((p) => p.names.forEach((n) => out.add(n)));
    for (const item of s.items) {
      if (Node.isVariableStatement(item)) item.getDeclarations().forEach((d) => bindingNames(d.getNameNode()).forEach((n) => out.add(n)));
      if ((Node.isFunctionDeclaration(item) || Node.isClassDeclaration(item)) && item.getName()) out.add(item.getName()!);
    }
    s.fn.forEachDescendant((d, walk) => {
      if (isFn(d) && d !== s.fn) return walk.skip();
      if (Node.isVariableDeclarationList(d) && d.getDeclarationKind() === "var") {
        d.getDeclarations().forEach((v) => bindingNames(v.getNameNode()).forEach((n) => out.add(n)));
      }
    });
    return out;
  });
  const refs = steps.map((s) => {
    const out = refNames(s.fn);
    s.params.filter((p) => aliases.has(p)).forEach((p) => out.delete(p.text));
    return out;
  });
  steps.forEach((_, i) =>
    steps.forEach((s, j) => {
      if (i === j) return;
      for (const name of declared[i]) {
        if (declared[j].has(name) || refs[j].has(name)) {
          throw new Skip(s.fn, `name \`${name}\` is declared in step ${i + 1} and used in step ${j + 1}`);
        }
      }
    })
  );
}
