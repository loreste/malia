// Identical Node HTTP application for external-client comparisons.
import http from 'node:http';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(req.url === '/metrics'
    ? JSON.stringify({ memory: process.memoryUsage(), cpu: process.cpuUsage() })
    : '{"ok":true}');
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
