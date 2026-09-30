// TypeScript standalone compilation test
interface User {
  id: number;
  name: string;
  roles: string[];
}

function formatUser(user: User): string {
  return `${user.name} (#${user.id}) [${user.roles.join(", ")}]`;
}

const u: User = { id: 42, name: "Alice", roles: ["admin", "engineer"] };
const formatted = formatUser(u);
console.log("TS Standalone Output:", formatted);
if (formatted !== "Alice (#42) [admin, engineer]") {
  throw new Error("Mismatch in TS standalone evaluation");
}
console.log("✓ TypeScript Ahead-Of-Time Standalone: PASS");
