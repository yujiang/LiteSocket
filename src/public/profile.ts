import { getSelfMsgId, logExceptionArgs } from './call';
import { EventCallbackFunc, isEnvProfile } from './Depends';
import { LiteLogger } from "./log";

let profileGlobal = isEnvProfile();
/**
 * Sets the global profiling flag used by newly created guard collections and nested profiling helpers.
 * @param p - Whether global profiling should be enabled.
 */
export function setProfile(p: boolean): void {
	console.log('set_profile', p);
	profileGlobal = p;
}
/**
 * Returns whether global profiling is enabled.
 */
export function isProfile(): boolean {
	return profileGlobal;
}

// 使用 performance.now() 有问题, ms没有更新now

/**
 * Returns a monotonic timestamp, or milliseconds elapsed since a nonzero timestamp.
 */
export function hrtime(time?: number) {
	if (!time) {
		return performance.now();
	}
	return performance.now() - time;
}

let profileLogger:LiteLogger = console;
let timeout = 1000;
/**
 * Sets the profiling logger and slow synchronous-call threshold in milliseconds.
 * @param logger - Logger implementing LiteLogger; console is supported.
 * @param tout - Slow-call threshold in milliseconds; defaults to 1000.
 */
export function setProfileLogger(logger:LiteLogger, tout = 1000) {
	profileLogger = logger;
	timeout = tout;
}

// 返回ms
/**
 * Returns [start timestamp, synchronous duration in milliseconds, return value]; does not await promises.
 * @param self - Receiver bound as this during callback invocation.
 * @param args - Unpacked arguments; variadic send APIs start with a message ID.
 */
export function profileCallCost(
	func: EventCallbackFunc,
	self: any,
	args: any[],
): [number, number, any] {
	const time = performance.now();
	const rt = func.apply(self, args);
	const cost = performance.now() - time;
	return [time, cost, rt];
}

/**
 * Counts handler invocations, synchronous execution time, and synchronous failures.
 */
export class CostGuard {
	protected guards: CostGuards;

	/**
	 * Creates CostGuard with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 */
	constructor(name: string, guards: CostGuards) {
		this.name = name;
		this.guards = guards;
	}

	/**
	 * Human-readable diagnostic label.
	 */
	name: string;

	/**
	 * Total invocation count recorded by this guard.
	 */
	called = 0; // call how many

	/**
	 * Accumulated synchronous invocation duration in milliseconds.
	 */
	mscost = 0; // 单位毫秒！

	/**
	 * Number of synchronous invocation failures recorded by this guard.
	 */
	error = 0;

	// return ms
	/**
	 * Returns mean synchronous invocation duration in milliseconds, or zero before any calls.
	 */
	percost(): number {
		if (this.called === 0) return 0;
		return this.mscost / this.called;
	}

	/**
	 * Invokes and measures synchronous cost without awaiting returned promises.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param args - Unpacked arguments; variadic send APIs start with a message ID.
	 */
	profileCall(func: EventCallbackFunc, self: unknown, args: any[]): any {
		const [_start, cost, rt] = profileCallCost(func, self, args);
		this.mscost += cost;
		if (cost >= timeout) {
			profileLogger?.error(
				'profile cost ',
				_start,
				this.name,
				args[1],
				`${(cost / 1000).toFixed(1)}s`,
				String(func),
			);
		} else if (cost > this.guards.printms) {
			profileLogger?.info(
				'profile cost ',
				_start,
				this.name,
				args[1],
				`${cost.toFixed(1)}ms`,
				func.name, // String(func), // func可能是匿名的!
			);
		}
		return rt;
	}

	/**
	 * Invokes with optional synchronous profiling; synchronous exceptions are logged and return null.
	 * @param self - Receiver bound as this during callback invocation.
	 * @param args - Unpacked arguments; variadic send APIs start with a message ID.
	 */
	tryCall(func: EventCallbackFunc, self: unknown, args: any[]): any {
		this.called++;
		try {
			if (!this.guards.profile) {
				return func.apply(self, args);
			}
			return this.profileCall(func, self, args);
		} catch (err) {
			this.error++;
			logExceptionArgs(`try_call_data ${this.name}`, err, args, getSelfMsgId(self, args));
			return null;
		}
	}

	running = 0; // counter for shared use!

	/**
	 * Prints accumulated synchronous invocation statistics.
	 */
	trace(logfunc = console.warn): void {
		const cost = (this.mscost / 1000).toFixed(2);
		const per = this.percost().toFixed(2);
		logfunc(
			`name ${this.name} run ${this.running} called ${this.called} cost(s):${cost} percost(ms):${per} error:${this.error}`,
		);
	}
}

/**
 * Collection of invocation guards with optional synchronous profiling.
 */
export class CostGuards {
	guards: { [key: string]: CostGuard } = {};

	/**
	 * Human-readable diagnostic label.
	 */
	name: string;

	/**
	 * Whether synchronous handler invocation profiling is enabled.
	 */
	profile = false;

	/**
	 * Minimum synchronous cost in milliseconds for profiling log entries.
	 */
	printms = 10; // 单位毫秒

	/**
	 * Creates CostGuards with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 */
	constructor(name: string) {
		this.name = name;
	}

	// if not find, auto new!
	/**
	 * Gets or creates a profiling guard by name.
	 * @param name - Diagnostic label.
	 */
	findGuard(name: string): CostGuard {
		// const dot = name.indexOf('.');
		// if (dot >= 0) {
		// 	name = name.left(dot);
		// }
		let guard = this.guards[name];
		if (!guard) {
			guard = new CostGuard(name, this);
			this.guards[name] = guard;
		}
		return guard;
	}

	/**
	 * Returns the named guard, or undefined when absent.
	 * @param name - Diagnostic label.
	 */
	getGuard(name: string): CostGuard {
		return this.guards[name];
	}

	/**
	 * Enables synchronous invocation profiling; promise completion time is excluded.
	 */
	setProfile(profile: boolean, printns = 10): void {
		this.profile = profile;
		this.printms = printns;
	}

	/**
	 * Prints accumulated synchronous invocation statistics.
	 */
	trace(top = 10, s = 0, per = false, logfunc = console.warn): void {
		costTrace(this.name, this.guards, top, s, per, logfunc);
	}
}

/**
 * Prints guards sorted by cumulative or average cost; threshold s is in seconds.
 * @param name - Diagnostic label.
 */
export function costTrace(
	/**
	 * Human-readable diagnostic label.
	 */
	name: string,
	handles: { [key: string]: CostGuard },
	top = 10,
	s = 0,
	sortper = false,
	logfunc = console.warn,
): void {
	logfunc('\n');
	const aa: CostGuard[] = Object.values(handles);
	logfunc('cost_trace', aa.length, name, top, s, sortper);

	if (sortper) {
		aa.sort((a: CostGuard, b: CostGuard) => b.percost() - a.percost());
	} else {
		aa.sort((a: CostGuard, b: CostGuard) => b.mscost - a.mscost);
	}

	let index = 0;
	for (const msg of aa) {
		if (msg.mscost >= s * 1000) {
			msg.trace(logfunc);
		}
		index++;
		if (index >= top) break;
	}
	logfunc('\n');
}

let funcLevel = 0;
let funcData: any[] = [];

function mulStr(s: string, mul: number): string {
	let rt = '';
	for (let i = 0; i < mul; i++) rt += s;
	return rt;
}

function traceFuncData(funcname: string): void {
	const start0 = funcData[funcData.length - 1][2];
	for (const data of funcData) {
		const [level, name, start, cost] = data;
		const cost2 = start - start0 + cost;
		const s = `${mulStr('    ', level) + name} :: ${cost2.toFixed(2)}ms`;
		console.warn(s);
		if (cost > 1000) console.error(s);
	}
	funcData = [];
	console.warn('guardFunc end', funcname, '\n');
}

function guardFunc(name: string, f: EventCallbackFunc, printns = 10): any {
	if (!profileGlobal) return f();
	funcLevel += 1;
	const [start, cost, rt] = profileCallCost(f, null, null);
	funcLevel -= 1;
	// console.log(name,cost,printns)
	if (cost >= printns) {
		funcData.push([funcLevel, name, start, cost]);
	}
	if (funcLevel === 0) {
		if (funcData.length > 0) {
			traceFuncData(name);
		}
	}
	return rt;
}

/**
 * Invokes a callback with optional nested synchronous profiling; printns is in milliseconds.
 * @param name - Diagnostic label.
 */
export function guardFunc2(name: string, f: EventCallbackFunc, printns = 1): any {
	if (!profileGlobal) return f();
	return guardFunc(name, f, printns);
}

const PlayerGuards = new CostGuards('Player');
/**
 * Returns the shared server-player profiling collection.
 */
export function getPlayerGuards(): CostGuards {
	return PlayerGuards;
}

const CPlayerGuards = new CostGuards('CPlayer');
/**
 * Returns the shared client-player profiling collection.
 */
export function getCPlayerGuards(): CostGuards {
	return CPlayerGuards;
}

const emitguards = new CostGuards('EmitGuards');
/**
 * Returns the shared send profiling collection.
 */
export function getEmitGuards(): CostGuards {
	return emitguards;
}
