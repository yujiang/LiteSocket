import { colors } from "./color";

/**
 * Injectable logging contract; console implements all required methods.
 */
export interface LiteLogger {
	info(...args: any[]): void;
    log(...args: any[]): void;
	warn(...args: any[]): void;
	error(...args: any[]): void;
	debug(...args: any[]): void;
}

/**
 * Creates a logger that discards every entry.
 */
export function createSliceLogger(){
    return {
        info(...args: any[]) {},
        log(...args: any[]) {},
        warn(...args: any[]) {},
        error(...args: any[]) {},
        debug(...args: any[]) {},
    }
}

/**
 * Creates a console logger prefixing entries with the supplied label.
 */
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

/**
 * Writes a highlighted message between separator lines.
 * @param logger - Logger implementing LiteLogger; console is supported.
 * @param msg - Numeric message ID or mutable business tuple, as specified by the signature.
 */
export function logStar(logger: LiteLogger, msg: string){
	logger.log(colors.green(star));
	logger.log(colors.yellow(msg));
	logger.log(colors.green(star));
	// logger.log(star);
	// logger.log(msg);
	// logger.log(star);
}