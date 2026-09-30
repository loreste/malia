// TypeScript main module importing a TS dependency.
import { add, type Pair } from "./ts_dep.ts";

interface Result {
  sum: number;
  label: string;
}

const pair: Pair = { a: 20, b: 22 };
const result: Result = { sum: add(pair.a, pair.b), label: "ts works" };

if (result.sum !== 42) throw new Error("bad sum");
console.log(`${result.label}: ${result.sum}`);

// Decorator-free enums and `as` casts transpile too.
enum Kind {
  A,
  B,
}
const k = Kind.B as Kind;
if (k !== 1) throw new Error("bad enum");
console.log("TS EXEC: PASS");
