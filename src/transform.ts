// Rewrites straight-line ff chains to an async arrow, ended with .then/.catch
// or util.callbackify. A chain that isn't straight-line is left as it is and
// reported with the reason. Mapping and behaviour notes: README.md.

import { Node, Project, SyntaxKind } from "ts-morph";
import { Ctx, Edit, MARK, Skip, Skipped, TransformResult } from "./types";
import { findChains, findFfImport, unwrapChain } from "./find";
import { analyzeStep, checkArgCounts, checkNothingRunsAfter, checkScopes, findAliases } from "./analyze";
import { emitChain, endingFor } from "./emit";
import { splitWrappers } from "./split";
import { fixImports } from "./imports";
import { applyEdits, refNames, templateRanges } from "./util";

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
  text = splitWrappers(project, fileName, text).split(MARK).join("");
  return { text: fixImports(project, fileName, text, used), converted, skipped };
}

export function convertChain(ctx: Ctx, decl: Node): Edit {
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
