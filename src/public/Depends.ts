// 之前的依赖都放在这里, 之后再慢慢分拣

// utils.ts
/**
 * Business tuple beginning with a positive numeric message ID.
 */
export type msgData = [number, ...any[]];
/**
 * Pair containing an event category and a business message tuple.
 */
export type packData = [string, msgData];
/**
 * String-keyed object containing unknown values.
 */
export type SimpleObj = Record<string, unknown>;

//struct.ts
/**
 * Business callback accepting unpacked arguments.
 */
export type EventCallbackFunc = (...args: any[]) => unknown;
/**
 * Numeric message ID to callback registration map.
 */
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
const processenv: Record<string, string> = {
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

