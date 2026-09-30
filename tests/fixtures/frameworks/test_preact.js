import { h } from 'preact';
import { render } from 'preact-render-to-string';

function Counter({ count }) {
  return h('div', { class: 'counter' },
    h('h2', null, `Count: ${count}`),
    h('p', null, 'Rendered on server via Malia')
  );
}

const html = render(h(Counter, { count: 42 }));
console.log('Preact SSR output:', html);
if (!html.includes('Count: 42')) throw new Error('Preact SSR failed');
console.log('PREACT_SSR: PASS');
