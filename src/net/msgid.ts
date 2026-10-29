export enum MsgId {
	// SYSTEM 保留 < 10
	MSG_SYSTEM_DEFAULT = 1,
	//MSG_SYSTEM_CALLBACK,
	//MSG_SYSTEM_HELLO,
	//MSG_SYSTEM_CONNECTIONID,
	MSG_SYSTEM_QUERYHTTPSERVER, //
	//MSG_SYSTEM_CONNECT,
	//MSG_SYSTEM_DISCONNECT,
	MSG_SYSTEM_END = 10,

	// room
	MSG_C2S_ROOM_OP,
	MSG_C2S_ROOM_BC,
	MSG_ROOM_END = 10,

    Max = 100, //自定义的error请从MAX之后开始!
}

// 从id获得name
export type getMsgNameFunc = (id: number) => string
let msgNameFunc: getMsgNameFunc;
export function setMsgNameFunc(func: getMsgNameFunc): void {
	msgNameFunc = func;
}

export function getMsgName(id: number): string {
	return msgNameFunc?.(id) || MsgId[id];
}

// 从name获得id
// export type getMsgIdFunc = (name: string) => number
// let msgIdFunc: getMsgIdFunc;
// export function setMsgIdFunc(func: getMsgIdFunc): void {
// 	msgIdFunc = func;
// }

// export function getMsgId(name: string): number {
// 	return msgIdFunc ? msgIdFunc(name) : MsgId[name];
// }

export enum NetEventEnum {
	// 广播消息
	eventBc = 'bc',
	// 一般的消息
	eventMod = 'mod',
	// 回调消息，无参数
	eventCallback = 'cb',
	// 回调消息的返回
	eventCallbacked = 'cb2',
	// aoi消息
	// eventAOI = 'a',
	// fight aoi
	// eventF = 'f',
	// gateway消息
	eventGate = 'g',
	eventGateMod = 'gmod',
	eventGateCallback = 'gcb',
	// pack消息
	// eventPack = 'p',
}

export function isCallbackMod(mod: string): boolean {
	return mod === NetEventEnum.eventCallback || mod === NetEventEnum.eventGateCallback;
}

