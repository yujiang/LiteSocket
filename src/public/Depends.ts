// 之前的依赖都放在这里, 之后再慢慢分拣

// utils.ts
export type msgData = [number, ...any[]];
export type packData = [string, msgData];
export type SimpleObj = Record<string, unknown>;

//struct.ts
export type EventCallbackFunc = (...args: any[]) => unknown;
export type EventMods = { [key: number]: EventCallbackFunc };

//Utils.ts
export class Utils {
	// _.size
	static lenObject(obj: {}): number {
		return Object.keys(obj).length;
	}

    static objectLen(obj: Object): number {
		return Utils.lenObject(obj);
	}
}

// env.ts
const processenv = {
	dev: '0',
};

export function getEnv(key: string): string {
	const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
	if (env) {
		return env[key];
	}
	return processenv[key];
}

export function isEnvProfile(): boolean {
	return getEnv('profile') === '1';
}


