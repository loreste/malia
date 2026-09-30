// Permission probe: fetches a (deliberately dead) local address. With net
// permission the failure is a connect error; without it the error must be
// PermissionDenied naming --allow-net.
try {
  await fetch("http://127.0.0.1:1/");
  console.log("UNREACHABLE");
} catch (err) {
  console.log("ERR " + (err?.message ?? String(err)));
}
