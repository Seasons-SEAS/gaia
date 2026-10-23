/**
 * calc_expr: a tiny arithmetic evaluator (+ − × ÷, parentheses, unary minus)
 * over named, receipt-backed inputs. Hand-written parser: no eval/Function, so
 * model-written text can never execute code.
 */
import { kernelEnvelope } from "./common";
import { KernelInputError } from "./errors";
import { fmtNum, makeReceipt, numberForms, pctForms, shortHash, stableJson } from "./numbers";

import type { ToolEnvelope } from "../types";

export type ExprInput = number | { value: number; receipt?: string; label?: string };

export interface CalcExprInput {
  expr: string;
  inputs: Record<string, ExprInput>;
  /** Short field name for the receipt id (letters, digits, _). */
  name?: string;
  /** "percent": the result is a fraction to be quoted as a percentage (0.6003 → 60.03%). */
  format?: "number" | "percent";
  label?: string;
}

export interface CalcExprData {
  expr: string;
  result: number;
  format: "number" | "percent";
  inputs: Record<string, { value: number; receipt?: string }>;
}

const MAX_LEN = 300;
const MAX_DEPTH = 32;

type Tok =
  | { k: "num"; v: number }
  | { k: "id"; v: string }
  | { k: "op"; v: "+" | "-" | "*" | "/" }
  | { k: "(" }
  | { k: ")" };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new KernelInputError("expr", `bad number at position ${i}`);
      out.push({ k: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0] });
      i += m[0].length;
    } else if (c === "+") {
      out.push({ k: "op", v: "+" });
      i++;
    } else if (c === "-" || c === "−") {
      out.push({ k: "op", v: "-" });
      i++;
    } else if (c === "*" || c === "×") {
      out.push({ k: "op", v: "*" });
      i++;
    } else if (c === "/" || c === "÷") {
      out.push({ k: "op", v: "/" });
      i++;
    } else if (c === "(") {
      out.push({ k: "(" });
      i++;
    } else if (c === ")") {
      out.push({ k: ")" });
      i++;
    } else {
      throw new KernelInputError("expr", `unexpected character "${c}"`);
    }
  }
  return out;
}

class Parser {
  private i = 0;
  readonly used = new Set<string>();
  constructor(
    private readonly toks: Tok[],
    private readonly vars: Record<string, number>,
  ) {}

  parse(): number {
    const v = this.expr(0);
    if (this.i < this.toks.length)
      throw new KernelInputError("expr", "unexpected token after the expression");
    return v;
  }

  private peek(): Tok | undefined {
    return this.toks[this.i];
  }

  // expr := term (("+"|"-") term)*
  private expr(depth: number): number {
    if (depth > MAX_DEPTH) throw new KernelInputError("expr", "expression is nested too deeply");
    let v = this.term(depth);
    for (let t = this.peek(); t && t.k === "op" && (t.v === "+" || t.v === "-"); t = this.peek()) {
      this.i++;
      const r = this.term(depth);
      v = t.v === "+" ? v + r : v - r;
    }
    return v;
  }

  // term := unary (("*"|"/") unary)*
  private term(depth: number): number {
    let v = this.unary(depth);
    for (let t = this.peek(); t && t.k === "op" && (t.v === "*" || t.v === "/"); t = this.peek()) {
      this.i++;
      const r = this.unary(depth);
      if (t.v === "/") {
        if (r === 0) throw new KernelInputError("expr", "division by zero");
        v = v / r;
      } else {
        v = v * r;
      }
    }
    return v;
  }

  // unary := ("-"|"+") unary | atom
  private unary(depth: number): number {
    const t = this.peek();
    if (t && t.k === "op" && (t.v === "-" || t.v === "+")) {
      this.i++;
      if (depth + 1 > MAX_DEPTH)
        throw new KernelInputError("expr", "expression is nested too deeply");
      const v = this.unary(depth + 1);
      return t.v === "-" ? -v : v;
    }
    return this.atom(depth);
  }

  // atom := number | identifier | "(" expr ")"
  private atom(depth: number): number {
    const t = this.toks[this.i++];
    if (!t) throw new KernelInputError("expr", "expression ends unexpectedly");
    if (t.k === "num") return t.v;
    if (t.k === "id") {
      if (!Object.prototype.hasOwnProperty.call(this.vars, t.v))
        throw new KernelInputError("expr", `unknown input "${t.v}"`);
      this.used.add(t.v);
      return this.vars[t.v]!;
    }
    if (t.k === "(") {
      const v = this.expr(depth + 1);
      const close = this.toks[this.i++];
      if (!close || close.k !== ")")
        throw new KernelInputError("expr", "missing closing parenthesis");
      return v;
    }
    throw new KernelInputError("expr", "unexpected token");
  }
}

/** Evaluate without building a receipt (for tests and internal use). */
export function evaluateExpr(
  expr: string,
  vars: Record<string, number>,
): { result: number; used: string[] } {
  if (typeof expr !== "string" || expr.trim() === "")
    throw new KernelInputError("expr", "expr must be a non-empty string");
  if (expr.length > MAX_LEN)
    throw new KernelInputError("expr", `expr must be at most ${MAX_LEN} characters`);
  const p = new Parser(tokenize(expr), vars);
  const result = p.parse();
  if (!Number.isFinite(result)) throw new KernelInputError("expr", "result is not a finite number");
  return { result, used: [...p.used] };
}

export function calcExpr(input: CalcExprInput): ToolEnvelope<CalcExprData> {
  if (!input || typeof input.inputs !== "object" || input.inputs === null) {
    throw new KernelInputError("inputs", "inputs must be an object of named numbers");
  }
  const format = input.format ?? "number";
  // Null-prototype maps: an input named "__proto__" stays an ordinary key.
  const vars: Record<string, number> = Object.create(null);
  const normalised: CalcExprData["inputs"] = Object.create(null);
  for (const [k, raw] of Object.entries(input.inputs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      throw new KernelInputError("inputs", `input name "${k}" is not a plain identifier`);
    const value = typeof raw === "number" ? raw : raw?.value;
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new KernelInputError(`inputs.${k}`, `input "${k}" must be a finite number`);
    vars[k] = value;
    normalised[k] =
      typeof raw === "object" && raw.receipt ? { value, receipt: raw.receipt } : { value };
  }
  const { result, used } = evaluateExpr(input.expr, vars);
  const name =
    input.name && /^[A-Za-z0-9_]{1,40}$/.test(input.name) ? input.name : shortHash(input.expr);
  const idTag = shortHash(stableJson({ expr: input.expr, vars, format }));
  const backing = used
    .map((k) => `${k}=${normalised[k]!.receipt ?? fmtNum(vars[k]!, 8)}`)
    .join(", ");
  const receipt = makeReceipt({
    id: `r:expr:${name}@${idTag}`,
    kind: "calc",
    label: input.label ?? `Derived figure: ${input.expr}`,
    locator: `calc_expr: ${input.expr}${backing ? ` [${backing}]` : ""}`,
    value: format === "percent" ? `${fmtNum(result * 100, 2)}%` : fmtNum(result, 8),
    numbers: [
      ...(format === "percent" ? pctForms(result) : numberForms(result)),
      ...used.map((k) => vars[k]!),
    ],
  });
  return kernelEnvelope({ expr: input.expr, result, format, inputs: normalised }, "calc_expr", [
    receipt,
  ]);
}
