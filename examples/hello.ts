// TypeScript hello world: types, interfaces, generics — transpile-only.
interface Greeting {
  who: string;
  punctuation?: string;
}

function greet<T extends Greeting>(g: T): string {
  return `hello, ${g.who}${g.punctuation ?? "!"}`;
}

enum Lang {
  TypeScript,
  JavaScript,
}

console.log(greet({ who: "jse" }));
console.log(`running ${Lang[Lang.TypeScript]} via V8`);

// Top-level await works in ES modules.
await sleep(1);
console.log("top-level await ok");
