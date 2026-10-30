import { ErrorEnum, IOClient } from '@mosnpm/litesocket/client';

declare global {
    interface Window {
        liteSocketExampleUrl: string;
    }
}

enum Message {
    Hello = 960001,
    HelloReply,
    Add,
}

const output = document.querySelector<HTMLPreElement>('#output');
const serverUrl = document.querySelector<HTMLElement>('#server-url');
const connectButton = document.querySelector<HTMLButtonElement>('#connect');
const helloButton = document.querySelector<HTMLButtonElement>('#hello');
const addButton = document.querySelector<HTMLButtonElement>('#add');
if (!output || !serverUrl || !connectButton || !helloButton || !addButton) {
    throw new Error('Library example page is missing required elements');
}

const client = new IOClient('browser-library-example', console, { checktimeout: true });
const write = (message: string) => {
    output.textContent += `${message}\n`;
};

serverUrl.textContent = window.liteSocketExampleUrl;
client.onMessage(Message.HelloReply, (message: string) => write(`Server replied: ${message}`));

connectButton.addEventListener('click', async () => {
    connectButton.disabled = true;
    const [connected] = await client.connectServer(window.liteSocketExampleUrl, (reason, error) => {
        write(`Disconnected: ${reason}${error ? ` (${String(error)})` : ''}`);
        connectButton.disabled = false;
        helloButton.disabled = true;
        addButton.disabled = true;
    });
    if (!connected) {
        write('Connection failed');
        connectButton.disabled = false;
        return;
    }
    write('Connected');
    helloButton.disabled = false;
    addButton.disabled = false;
});

helloButton.addEventListener('click', () => client.sendMsg(Message.Hello, 'browser'));
addButton.addEventListener('click', async () => {
    const [code, sum] = await client.asendCallback(Message.Add, 3, 5);
    write(code === ErrorEnum.ErrorOk ? `RPC result: ${sum}` : `RPC failed: ${code}`);
});

window.addEventListener('pagehide', () => client.destroy('page hidden'));
