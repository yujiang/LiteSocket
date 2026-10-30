export enum Message {
    Hello = 960001,
    HelloReply,
    Add,
}

export function getMsgName(id: number): string {
    return Message[id];
}
