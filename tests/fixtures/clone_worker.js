// Clone worker: echoes the payload back untouched.
onmessage = (e) => {
  postMessage(e.data);
};
