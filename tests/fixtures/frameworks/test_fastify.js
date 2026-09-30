import Fastify from 'fastify';

const app = Fastify({ logger: false });

app.get('/health', async (request, reply) => {
  return { status: 'healthy', runtime: 'malia', timestamp: Date.now() };
});

app.post('/echo', async (request, reply) => {
  const body = request.body;
  return { received: body };
});

// Test 1: GET /health via inject
const healthRes = await app.inject({
  method: 'GET',
  url: '/health'
});

console.log('Fastify GET /health status:', healthRes.statusCode);
console.log('Fastify GET /health payload:', healthRes.payload);

if (healthRes.statusCode !== 200) {
  throw new Error(`Expected status 200, got ${healthRes.statusCode}`);
}

const healthJson = JSON.parse(healthRes.payload);
if (healthJson.runtime !== 'malia') {
  throw new Error(`Expected runtime 'malia', got ${healthJson.runtime}`);
}

// Test 2: POST /echo via inject
const echoRes = await app.inject({
  method: 'POST',
  url: '/echo',
  payload: { framework: 'fastify', works: true }
});

console.log('Fastify POST /echo status:', echoRes.statusCode);
console.log('Fastify POST /echo payload:', echoRes.payload);

if (echoRes.statusCode !== 200) {
  throw new Error(`Expected status 200, got ${echoRes.statusCode}`);
}

const echoJson = JSON.parse(echoRes.payload);
if (!echoJson.received || echoJson.received.framework !== 'fastify') {
  throw new Error(`Echo payload mismatch: ${echoRes.payload}`);
}

console.log('FASTIFY: PASS');
