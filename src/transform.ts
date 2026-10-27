import { ArrowFunction, CallExpression, FunctionExpression, Node, ParameterDeclaration, Project, SourceFile, SyntaxKind } from "ts-morph";

// Rewrites straight-line ff chains to an async arrow, ended with .then/.catch
// or util.callbackify. A chain that isn't straight-line is left as it is and
// reported with the reason. Mapping and behaviour notes: README.md.

export interface Skipped {
  line: number;
  reason: string;
}

export interface TransformResult {
  text: string;
  converted: number;
  skipped: Skipped[];
}

class Skip extends Error {
  constructor(node: Node, reason: string) {
    super(`${reason} (line ${node.getStartLineNumber()})`);
  }
}

// A piece of output. `pos` is the offset of `text` in the original source,
// so its lines can be re-indented; generated text has no `pos`.
interface Piece {
  text: string;
  pos?: number;
}

interface Edit {
  start: number;
  end: number;
  pieces: Piece[];
}

type SlotKind = "slot" | "wait" | "slotMulti" | "slotPlain" | "waitPlain";
const SLOT_KINDS = new Set<string>(["slot", "wait", "slotMulti", "slotPlain", "waitPlain"]);
const HANDLERS: Record<string, string> = {
  onSuccess: "onSuccess",
  success: "onSuccess",
  onError: "onError",
  error: "onError",
  onComplete: "onComplete",
  cb: "onComplete",
};

// One f.slot()/f.wait()/f.pass() at the top level of a step.
interface Reg {
  item: Node;
  fCall: CallExpression;
  kind: SlotKind | "pass";
  n: number; // values it adds to the next step's args
  host?: CallExpression; // the call that gets the slot callback
  argIndex?: number;
  pos?: number; // index in the promise array of a step with branches
}

interface Param {
  node: ParameterDeclaration;
  text: string;
  names: string[];
  type?: string;
}

interface Step {
  fn: ArrowFunction | FunctionExpression;
  items: Node[]; // top-level statements, or the body of an expression arrow
  params: Param[];
  regs: Reg[];
  terminals: CallExpression[];
  shape: number[]; // values given at each position, see walkStep
  valueCount: number;
  branched: boolean; // a registration is inside an if/else
}

interface Ctx {
  sf: SourceFile;
  text: string;
  ts: boolean;
  fName: string;
  templates: [number, number][];
  used: Set<string>;
  fresh: Set<string>;
}

export function transform(source: string, fileName = "file.js"): TransformResult {
  const project = new Project({ useInMemoryFileSystem: true });
  const used = new Set<string>();
  let text = source;
  let converted = 0;
  let skipped: Skipped[] = [];
  // A chain nested in another one converts first; the outer one can convert
  // on the next pass, once its step no longer contains a nested chain.
  for (let pass = 0; pass < 20; pass++) {
    const sf = project.createSourceFile(fileName, text, { overwrite: true });
    const ffName = findFfImport(sf)?.name;
    if (!ffName) break;
    const edits: Edit[] = [];
    const fresh = new Set<string>();
    skipped = [];
    for (const decl of findChains(sf, ffName)) {
      const stmt = decl.getFirstAncestorByKindOrThrow(SyntaxKind.VariableStatement);
      const line = stmt.getStartLineNumber();
      if (edits.some((e) => e.start < stmt.getEnd() && stmt.getStart() < e.end)) continue;
      try {
        const ctx: Ctx = { sf, text, ts: /\.tsx?$/.test(fileName), fName: "", templates: templateRanges(sf), used, fresh };
        edits.push(convertChain(ctx, decl));
      } catch (e) {
        if (!(e instanceof Skip)) throw e;
        skipped.push({ line, reason: e.message });
      }
    }
    if (!edits.length) break;
    converted += edits.length;
    text = applyEdits(text, edits);
  }
  return { text: fixImports(project, fileName, text, used), converted, skipped };
}

// ---------------------------------------------------------------- finding

function findFfImport(sf: SourceFile): { name: string; stmt: Node; esm: boolean; quote: string } | undefined {
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

function isRequireOf(node: Node, mod: string): boolean {
  if (!Node.isCallExpression(node) || node.getExpression().getText() !== "require") return false;
  const [arg] = node.getArguments();
  return !!arg && Node.isStringLiteral(arg) && arg.getLiteralValue() === mod;
}

const quoteOf = (s: string) => (s.includes("'") ? "'" : '"');

// `const f = ff(...).onSuccess(...)...` declarations, outermost first.
function findChains(sf: SourceFile, ffName: string) {
  return sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).filter((d) => {
    const init = d.getInitializer();
    return init && unwrapChain(init, ffName);
  });
}

function unwrapChain(expr: Node, ffName: string) {
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

// ---------------------------------------------------------------- analysis

function convertChain(ctx: Ctx, decl: Node): Edit {
  const stmt = decl.getFirstAncestorByKindOrThrow(SyntaxKind.VariableStatement);
  if (!Node.isVariableDeclaration(decl) || !Node.isIdentifier(decl.getNameNode())) {
    throw new Skip(decl, "chain is not assigned to a plain variable");
  }
  if (stmt.getDeclarations().length !== 1) throw new Skip(stmt, "several declarations in one statement");
  ctx.fName = decl.getName();
  const { ffCall, handlers } = unwrapChain(decl.getInitializerOrThrow(), findFfImport(ctx.sf)!.name)!;

  checkNothingRunsAfter(ctx, stmt);
  for (const h of handlers) {
    if (h.call.getArguments().length !== 1) throw new Skip(h.call, `.${h.kind}() needs exactly one handler`);
    if (refNames(h.call.getArguments()[0]).has(ctx.fName)) throw new Skip(h.call, "a handler uses the chain variable");
  }

  const fns = ffCall.getArguments();
  if (!fns.length) throw new Skip(ffCall, "chain has no steps");
  const steps = fns.map((fn) => analyzeStep(ctx, fn));
  if (steps[0].params.length) throw new Skip(steps[0].fn, "the first step takes parameters; ff passes it none");
  checkArgCounts(steps);
  const aliases = findAliases(steps);
  checkScopes(steps, aliases);

  const ending = endingFor(ctx, handlers);
  return { start: stmt.getStart(), end: stmt.getEnd(), pieces: emitChain(ctx, stmt, steps, aliases, ending) };
}

// In ff, step 1 starts on the next tick; the async version starts it right
// away. That is only safe when nothing runs after the chain is set up.
function checkNothingRunsAfter(ctx: Ctx, stmt: Node) {
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

function analyzeStep(ctx: Ctx, fn: Node): Step {
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
function endsStep(fn: Step["fn"], stmt: Node): boolean {
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
function walkStep(ctx: Ctx, items: Node[], terminals: CallExpression[]) {
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

function fMethod(ctx: Ctx, call: Node): string | undefined {
  if (!Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getExpression().getText() !== ctx.fName) return undefined;
  return callee.getName();
}

// A top-level `f.pass(...)`, or `host(..., f.slot())` with the slot as one argument.
function classify(ctx: Ctx, item: Node): Reg | undefined {
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
function split(step: Step) {
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

function checkArgCounts(steps: Step[]) {
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

const step0Index = (s: Step, r: Reg) => s.items.indexOf(r.item);
function tailStart(s: Step) {
  let start = s.items.length;
  while (start > 0 && s.regs.some((r) => r.item === s.items[start - 1])) start--;
  return start;
}

// The values each step's registrations give, as names of the next step's
// params (undefined where the next step doesn't name it).
function namesFor(steps: Step[], i: number): (Param | undefined)[] {
  const n = steps[i].valueCount;
  const params = steps[i + 1]?.params ?? [];
  return Array.from({ length: n }, (_, k) => params[k]);
}

// `f.pass(x)` into a param also named `x` needs no declaration: the step
// after it can use `x` directly.
function findAliases(steps: Step[]): Set<Param> {
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
function checkScopes(steps: Step[], aliases: Set<Param>) {
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

// ---------------------------------------------------------------- output

interface Ending {
  head: string;
  tail: (stmtIndent: string) => Piece[];
}

function endingFor(ctx: Ctx, handlers: { kind: string; call: CallExpression }[]): Ending {
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
    return { head: "callbackify(async () => {", tail: (ind) => [gen("})("), ...handlerPieces(arg("onComplete")!, ind), gen(");")] };
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

function emitChain(ctx: Ctx, stmt: Node, steps: Step[], aliases: Set<Param>, ending: Ending): Piece[] {
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

function stepEdits(
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
function branchedEdits(
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
function freshName(ctx: Ctx, base: string): string {
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
function withComments(ctx: Ctx, tail: Reg[], pieces: Piece[], target: string): Piece[] {
  const comments = tail.slice(1).flatMap((r) => r.item.getLeadingCommentRanges().map((c) => c.getText()));
  return [...comments.map((c) => gen(c + "\n" + target)), ...pieces];
}

// One Promise.all element per value source: a slot's promise, or one per
// pass argument, with the next step's params it fills.
// A pass into a param of the same name (an alias) needs no element.
function elements(ctx: Ctx, regs: Reg[], names: (Param | undefined)[], offset: Map<Reg, number>, aliases: Set<Param>) {
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

function bindingFor(names: (Param | undefined)[]): { text: string; type?: string } {
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

function valuePieces(ctx: Ctx, r: Reg): Piece[] {
  const [a] = r.fCall.getArguments();
  return [orig(ctx, a.getStart(), a.getEnd())];
}

// The promise for a slot: promisify(fn)(args) where that keeps `this` and
// argument order, else a hand-written new Promise.
function promisePieces(ctx: Ctx, r: Reg): Piece[] {
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

// ---------------------------------------------------------------- imports

function fixImports(project: Project, fileName: string, text: string, used: Set<string>): string {
  const sf = project.createSourceFile(fileName, text, { overwrite: true });
  const imp = findFfImport(sf);
  const needed = [...used].sort().filter((n) => !isBoundAtTop(sf, n));
  if (!imp) return text;
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

function isBoundAtTop(sf: SourceFile, name: string): boolean {
  return (
    !!sf.getVariableDeclaration(name) ||
    sf.getImportDeclarations().some((d) => d.getNamedImports().some((n) => (n.getAliasNode() ?? n.getNameNode()).getText() === name))
  );
}

// ---------------------------------------------------------------- helpers

const gen = (text: string): Piece => ({ text });
const orig = (ctx: Ctx, start: number, end: number): Piece => ({ text: ctx.text.slice(start, end), pos: start });

function copyWithEdits(ctx: Ctx, start: number, end: number, edits: Edit[]): Piece[] {
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

function joinPieces(lists: Piece[][]): Piece[] {
  return lists.flatMap((l, i) => (i ? [gen(", "), ...l] : l));
}

// Concatenates pieces, shifting every original line left by `delta` columns
// (right if negative). Lines inside a multi-line template literal keep
// their indentation, since it is part of the string.
function render(ctx: Ctx, pieces: Piece[], delta: number): string {
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

function shift(line: string, delta: number): string {
  if (delta < 0) return line.trim() ? " ".repeat(-delta) + line : line;
  let i = 0;
  while (i < delta && (line[i] === " " || line[i] === "\t")) i++;
  return line.slice(i);
}

function templateRanges(sf: SourceFile): [number, number][] {
  return sf
    .getDescendants()
    .filter((n) => Node.isNoSubstitutionTemplateLiteral(n) || Node.isTemplateExpression(n))
    .filter((n) => n.getText().includes("\n"))
    .map((n) => [n.getStart(), n.getEnd()]);
}

function applyEdits(text: string, edits: Edit[]): string {
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, e.start) + e.pieces.map((p) => p.text).join("") + text.slice(e.end);
  }
  return text;
}

function indentAt(text: string, pos: number): string {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function bodyIndent(ctx: Ctx, step: Step): string {
  const body = step.fn.getBody()!;
  if (!Node.isBlock(body)) return indentAt(ctx.text, body.getStart());
  let i = body.getStart() + 1;
  while (i < body.getEnd() - 1 && /\s/.test(ctx.text[i])) i++;
  return indentAt(ctx.text, i);
}

function bindingNames(name: Node): string[] {
  if (Node.isIdentifier(name)) return [name.getText()];
  return name.getDescendantsOfKind(SyntaxKind.BindingElement).flatMap((b) => {
    const n = b.getNameNode();
    return Node.isIdentifier(n) ? [n.getText()] : [];
  });
}

function isPropertyName(id: Node): boolean {
  const p = id.getParent();
  if (!p) return false;
  if (Node.isPropertyAccessExpression(p)) return p.getNameNode() === id;
  if (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p) || Node.isPropertyDeclaration(p) || Node.isPropertySignature(p)) {
    return p.getNameNode() === id;
  }
  if (Node.isBindingElement(p)) return p.getPropertyNameNode() === id;
  return false;
}

function refNames(node: Node): Set<string> {
  const out = new Set<string>();
  const visit = (d: Node) => {
    if (Node.isIdentifier(d) && !isPropertyName(d)) out.add(d.getText());
  };
  visit(node);
  node.forEachDescendant(visit);
  return out;
}

function isAssigned(fn: Node, name: string): boolean {
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

function isFn(n: Node): boolean {
  return Node.isFunctionLikeDeclaration(n) || Node.isFunctionExpression(n);
}
