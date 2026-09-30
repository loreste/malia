import React from 'react';
import { renderToString } from 'react-dom/server';

function App({ title, items }) {
  return React.createElement('div', { className: 'container' },
    React.createElement('h1', null, title),
    React.createElement('ul', null, items.map((item, i) =>
      React.createElement('li', { key: i }, item)
    ))
  );
}

const html = renderToString(React.createElement(App, {
  title: 'Malia React SSR',
  items: ['Fast', 'Lightweight', 'Rust-Powered']
}));

console.log('React SSR output:', html);
if (!html.includes('<h1') || !html.includes('Malia React SSR')) {
  throw new Error('React SSR failed');
}
console.log('REACT_SSR: PASS');
