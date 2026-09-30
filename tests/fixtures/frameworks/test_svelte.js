import * as compiler from 'svelte/compiler';
import { render } from 'svelte/server';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

console.log('Svelte version:', compiler.VERSION);

const source = `
<script>
  let { name = 'World', count = 0 } = $props();
</script>

<main class="container">
  <h1>Hello {name}!</h1>
  <p>Count: {count}</p>
</main>
`;

const compiled = compiler.compile(source, {
  generate: 'server'
});

const tempComponentPath = fileURLToPath(new URL('./temp_svelte_component.js', import.meta.url));
fs.writeFileSync(tempComponentPath, compiled.js.code);

try {
  const { default: Component } = await import('./temp_svelte_component.js');
  const result = render(Component, {
    props: {
      name: 'Malia',
      count: 42
    }
  });

  console.log('Rendered Svelte HTML:', result.body);

  if (!result.body.includes('Hello Malia!') || !result.body.includes('Count: 42')) {
    throw new Error(`Unexpected Svelte SSR output: ${result.body}`);
  }

  console.log('SVELTE_SSR: PASS');
} finally {
  try {
    fs.unlinkSync(tempComponentPath);
  } catch (_) {}
}
