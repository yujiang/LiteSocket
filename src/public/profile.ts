import { getSelfMsgId, logExceptionArgs } from './call';
import { EventCallbackFunc, isEnvProfile } from './Depends';
import { LiteLogger } from "./log";

let profileGlobal = isEnvProfile();
export function setProfile(p: boolean): void {
	console.log('set_profile', p);
	profileGlobal = p;
}
export function isProfile(): boolean {
	return profileGlobal;
}

// 使用 performance.now() 有问题, ms没有更新now

export function hrtime(time?: number) {
	if (!time) {
		return performance.now();
	}
	return performance.now() - time;
}

let profileLogger:LiteLogger = console;
let timeout = 1000;
export function setProfileLogger(logger:LiteLogger, tout = 1000) {
	profileLogger = logger;
	timeout = tout;
}

// 返回ms
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

export class CostGuard {
	protected guards: CostGuards;

	constructor(name: string, guards: CostGuards) {
		this.name = name;
		this.guards = guards;
	}

	name: string;

	called = 0; // call how many

	mscost = 0; // 单位毫秒！

	error = 0;

	// return ms
	percost(): number {
		if (this.called === 0) return 0;
		return this.mscost / this.called;
	}

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

	trace(logfunc = console.warn): void {
		const cost = (this.mscost / 1000).toFixed(2);
		const per = this.percost().toFixed(2);
		logfunc(
			`name ${this.name} run ${this.running} called ${this.called} cost(s):${cost} percost(ms):${per} error:${this.error}`,
		);
	}
}

export class CostGuards {
	guards: { [key: string]: CostGuard } = {};

	name: string;

	profile = false;

	printms = 10; // 单位毫秒

	constructor(name: string) {
		this.name = name;
	}

	// if not find, auto new!
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

	getGuard(name: string): CostGuard {
		return this.guards[name];
	}

	setProfile(profile: boolean, printns = 10): void {
		this.profile = profile;
		this.printms = printns;
	}

	trace(top = 10, s = 0, per = false, logfunc = console.warn): void {
		costTrace(this.name, this.guards, top, s, per, logfunc);
	}
}

export function costTrace(
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

export function guardFunc2(name: string, f: EventCallbackFunc, printns = 1): any {
	if (!profileGlobal) return f();
	return guardFunc(name, f, printns);
}

const PlayerGuards = new CostGuards('Player');
export function getPlayerGuards(): CostGuards {
	return PlayerGuards;
}

const CPlayerGuards = new CostGuards('CPlayer');
export function getCPlayerGuards(): CostGuards {
	return CPlayerGuards;
}

const emitguards = new CostGuards('EmitGuards');
export function getEmitGuards(): CostGuards {
	return emitguards;
}
