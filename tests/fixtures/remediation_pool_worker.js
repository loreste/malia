onmessage = async ({ data }) => {
  if (data.kind === 'run') {
    await sleep(10);
    postMessage(data.value);
  } else if (data.kind === 'stream') {
    postMessage('first');
    await sleep(10);
    postMessage('second');
    postMessage({ __done: true });
  } else if (data.kind === 'throw') {
    throw new Error('worker failure');
  }
};
