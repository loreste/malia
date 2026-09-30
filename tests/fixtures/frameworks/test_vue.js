import { createSSRApp, h } from 'vue';
import { renderToString } from '@vue/server-renderer';

const app = createSSRApp({
  data() {
    return { message: 'Hello from Vue 3 SSR on Malia', count: 100 };
  },
  render() {
    return h('div', { id: 'app' }, [
      h('h1', this.message),
      h('span', `Counter: ${this.count}`)
    ]);
  }
});

const html = await renderToString(app);
console.log('Vue 3 SSR output:', html);
if (!html.includes('Hello from Vue 3 SSR on Malia') || !html.includes('Counter: 100')) {
  throw new Error('Vue 3 SSR failed');
}
console.log('VUE_SSR: PASS');
