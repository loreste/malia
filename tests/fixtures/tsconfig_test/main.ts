import { greet } from "@/helper";

const msg = greet("Antigravity");
if (msg !== "Hello from @/helper, Antigravity!") {
  throw new Error(`Unexpected message: ${msg}`);
}
console.log("TSCONFIG PATHS: PASS");
