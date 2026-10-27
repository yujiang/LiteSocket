import { EventCallbackFunc } from "./Depends";

export function logExceptionArgs(where: string, error: any, args: unknown, playerid: number): void {}

export function getSelfId(self: any) {
	if (self == null || typeof self !== 'object') {
		return 0;
	}
	// eslint-disable-next-line dot-notation
	if (self.player) {
		return self.player.id || 0;
	}
	return self.id || 0;
}

export function getMsgId(data: any[]) {
// data = player
	return typeof data[0] === 'object' ? data[0].id || 0 : 0;
}

export function getSelfMsgId(self: unknown, data: any[]) {
	if (self) {
		return getSelfId(self);
	}
	return getMsgId(data);
}

export function tryCallfunctionRt(func: EventCallbackFunc, args: any[], self: unknown): boolean {
	try {
		return func.apply(self, args);
	} catch (err) {
		logExceptionArgs('try_callfunction_rt', err, args, getSelfId(self));
		return false;
	}
}

export function tryCallfunction(func: EventCallbackFunc, args: any[], self: unknown): boolean {
	try {
		func.apply(self, args);
		return true;
	} catch (err) {
		logExceptionArgs('try_callfunction', err, args, getSelfId(self));
		return false;
	}
}

export function tryCall(func: EventCallbackFunc, args: unknown): boolean {
	try {
		func(args);
		return true;
	} catch (err) {
		logExceptionArgs('try_callfunction', err, args, 0);
		return false;
	}
}
