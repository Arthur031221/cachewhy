import { createServer } from 'node:http';

const port = Number(process.env.CACHEWHY_DEMO_PORT || 3033);
const server = createServer((request, response) => {
  if (request.url?.startsWith('/missing.js')) {
    response.writeHead(404, { 'Cache-Control': request.url.includes('fixed=1') ? 'no-store' : 'public, max-age=2678400', 'Content-Type': 'text/plain' });
    response.end('not found');
  } else if (request.url === '/shared') {
    response.writeHead(200, { 'Cache-Control': 'private, max-age=0, s-maxage=600' });
    response.end('shared example');
  } else {
    response.writeHead(404, { 'Cache-Control': 'no-store' });
    response.end('unknown path');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`fixture listening at http://127.0.0.1:${port}`));
