// Echo worker: doubles numbers, passes objects through.
onmessage = (e) => {
  const d = e.data;
  if (typeof d === "number") {
    postMessage(d * 2);
  } else {
    postMessage({ ...d, n: d.n * 2 });
  }
};
