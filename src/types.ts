// Types and constants shared by the modules.

import { ArrowFunction, CallExpression, FunctionExpression, Node, ParameterDeclaration, SourceFile } from "ts-morph";

export interface Skipped {
  line: number;
  reason: string;
}

export interface TransformResult {
  text: string;
  converted: number;
  skipped: Skipped[];
}

export class Skip extends Error {
  constructor(node: Node, reason: string) {
    super(`${reason} (line ${node.getStartLineNumber()})`);
  }
}

// A piece of output. `pos` is the offset of `text` in the original source,
// so its lines can be re-indented; generated text has no `pos`.
export interface Piece {
  text: string;
  pos?: number;
}

export interface Edit {
  start: number;
  end: number;
  pieces: Piece[];
}

export type SlotKind = "slot" | "wait" | "slotMulti" | "slotPlain" | "waitPlain";

export const SLOT_KINDS = new Set<string>(["slot", "wait", "slotMulti", "slotPlain", "waitPlain"]);

export const HANDLERS: Record<string, string> = {
  onSuccess: "onSuccess",
  success: "onSuccess",
  onError: "onError",
  error: "onError",
  onComplete: "onComplete",
  cb: "onComplete",
};

// One f.slot()/f.wait()/f.pass() at the top level of a step.
export interface Reg {
  item: Node;
  fCall: CallExpression;
  kind: SlotKind | "pass";
  n: number; // values it adds to the next step's args
  host?: CallExpression; // the call that gets the slot callback
  argIndex?: number;
  pos?: number; // index in the promise array of a step with branches
}

export interface Param {
  node: ParameterDeclaration;
  text: string;
  names: string[];
  type?: string;
}

export interface Step {
  fn: ArrowFunction | FunctionExpression;
  items: Node[]; // top-level statements, or the body of an expression arrow
  params: Param[];
  regs: Reg[];
  terminals: CallExpression[];
  shape: number[]; // values given at each position, see walkStep
  valueCount: number;
  branched: boolean; // a registration is inside an if/else
}

export interface Ctx {
  sf: SourceFile;
  text: string;
  ts: boolean;
  fName: string;
  templates: [number, number][];
  used: Set<string>;
  fresh: Set<string>;
}

// Marks the callbackify wrappers this codemod wrote, so splitWrappers
// leaves callbackify calls that were already in the file alone.
export const MARK = "/*ff2async*/";
