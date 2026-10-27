import * as chalk from 'chalk';
const colors = chalk;

export interface LiteLogger {
	info(...args: any[]): void;
    log(...args: any[]): void;
	warn(...args: any[]): void;
	error(...args: any[]): void;
	debug(...args: any[]): void;
}

export function createSliceLogger(){
    return {
        info(...args: any[]) {},
        log(...args: any[]) {},
        warn(...args: any[]) {},
        error(...args: any[]) {},
        debug(...args: any[]) {},
    }
}

export function createHeadLogger(head: string){
    return {
        info(...args: any[]) {
            console.info(`[${head}]`, ...args)
        },
        log(...args: any[]) {
            console.log(`[${head}]`, ...args)
        },
        warn(...args: any[]) {
            console.warn(`[${head}]`, ...args)
        },
        error(...args: any[]) {
            console.error(`[${head}]`, ...args)
        },
        debug(...args: any[]) {
            console.debug(`[${head}]`, ...args)
        },
    }
}

const star = '***************************************************************';

export function logStar(logger: LiteLogger, msg: string){
	logger.log(colors.green(star));
	logger.log(colors.yellow(msg));
	logger.log(colors.green(star));
}