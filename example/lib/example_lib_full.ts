import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ErrorEnum, IOServer, setMsgNameFunc } from '@mosnpm/litesocket';
import type { IOServerSocket } from '@mosnpm/litesocket';
import { getMsgName, Message } from './example_lib_msg';

async function main(): Promise<void> {
    const root = process.cwd();
    setMsgNameFunc(getMsgName);
    const server = new IOServer('library-example', console);
    server.onMessage(Message.Hello, (socket: IOServerSocket, name: string) => {
        socket.sendMsg(Message.HelloReply, `Hello, ${name}!`);
    });
    server.onCallback(Message.Add, (_socket: IOServerSocket, left: number, right: number) => [
        ErrorEnum.ErrorOk,
        left + right,
    ]);

    const [listening, listenError] = await server.listen(0);
    if (!listening) throw listenError;

    const http = createServer(async (request, response) => {
        try {
            const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
            if (pathname === '/') {
                const html = await readFile(resolve(root, 'example/lib/index.html'), 'utf8');
                response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                response.end(html.replace('__WS_URL__', `ws://127.0.0.1:${server.io.port}`));
                return;
            }

            const assets: Record<string, [string, string]> = {
                '/example_lib_brower.js': ['.example-build/example/lib/example_lib_brower.js', 'text/javascript'],
                '/lib/client/index.js': ['lib/client/index.js', 'text/javascript'],
            };
            const asset = assets[pathname];
            if (!asset) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }
            response.writeHead(200, { 'content-type': `${asset[1]}; charset=utf-8` });
            response.end(await readFile(resolve(root, asset[0])));
        } catch (error) {
            console.error('Example HTTP request failed:', error);
            if (!response.headersSent) response.writeHead(500);
            response.end('Internal server error');
        }
    });

    await new Promise<void>((resolveListen, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', resolveListen);
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('HTTP server did not bind to a TCP port');
    console.log(`Open http://127.0.0.1:${address.port} to try the built browser client.`);
    console.log(`WebSocket server listening on port ${server.io.port}. Press Ctrl+C to stop.`);

    const close = () => {
        http.close();
        server.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
}

main().catch(error => {
    console.error('Library example failed:', error);
    process.exitCode = 1;
});
