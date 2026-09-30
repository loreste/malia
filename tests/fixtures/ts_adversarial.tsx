// Adversarial TypeScript & JSX tests: TSX, JSX pragmas, decorators, type stripping, extensionless resolution

// Mock React for JSX transform
const React = {
  createElement(tag: any, props: any, ...children: any[]) {
    return {
      tag,
      props: {
        ...(props || {}),
        children: children.flat(),
      },
    };
  },
};

// 1. Extensionless TSX import
import { MyComponent, renderMock } from "./jsx_component";

const mockComp = MyComponent({ name: "TypeScript Engine", count: 99 });
const rendered = renderMock(mockComp);
if (!rendered.includes("Hello, TypeScript Engine!") || !rendered.includes("Count: 99")) {
  throw new Error(`TSX component render failed: ${rendered}`);
}

// 2. Direct JSX syntax execution
const jsxTree: any = (
  <div id="adversarial-root" className="container">
    <header>
      <h1>Engine Benchmark</h1>
    </header>
    <main>
      <p>Zero unsafe, 100% safe Rust core.</p>
    </main>
  </div>
);

if (jsxTree.tag !== "div" || jsxTree.props.id !== "adversarial-root" || jsxTree.props.children.length !== 2) {
  throw new Error(`JSX tree mismatch: ${JSON.stringify(jsxTree)}`);
}

// 3. Decorator support (ECMA decorators)
function logged(value: any, context: any) {
  if (context.kind === "class") {
    return class extends value {
      isDecorated = true;
    };
  }
  return value;
}

@logged
class FastProcessor {
  process(x: number): number {
    return x * 2;
  }
}

const proc: any = new FastProcessor();
if (proc.process(21) !== 42 || !proc.isDecorated) {
  throw new Error(`Decorator execution failed, isDecorated=${proc.isDecorated}`);
}

// 4. Advanced TypeScript types & type-only import stripping
type EventName<T extends string> = `on${Capitalize<T>}`;
type OnClick = EventName<"click">;
const eventKey: OnClick = "onClick";

type DeepReadonly<T> = {
  readonly [P in keyof T]: DeepReadonly<T[P]>;
};

interface AppConfig {
  env: string;
  threads: number;
}

const cfg: DeepReadonly<AppConfig> = { env: "prod", threads: 8 };

if (eventKey !== "onClick" || cfg.threads !== 8) {
  throw new Error("Type assertion mismatch");
}

console.log("TS ADVERSARIAL: PASS");
