/**
 * Error-first result codes; ErrorOk is zero and custom codes should exceed Max.
 */
export enum ErrorEnum {
	/** Successful operation; numeric value zero. */
	ErrorOk,
	/** Generic business or operation failure. */
	ErrorError,
	//Error_notdev,
	//Error_notclient,

	/** No usable transport is available for the request. */
	Net_notconnect,

    /** The registered message handler is administratively disabled. */
    Msg_closed,
	/** No RPC handler is registered for the requested message ID. */
	Handle_not_find,

    /** A scheduled/manual timeout check found this pending request expired. */
    Callback_timeout,
	/** Reserved legacy callback lookup failure; retained for numeric compatibility. */
	Callback_not_find,
	/** The RPC handler returned neither an error code nor a valid error-first array. */
	Callback_rt_invalid,
	/** The argument filter rejected the request by returning a falsy value. */
	Callback_filter_null,
	/** The connection was lost or disposed while the request was pending. */
	Callback_disconnect,
    /** The RPC handler returned a promise that rejected. */
    Callback_await_error,
	/** The RPC handler returned null/undefined, including after a caught synchronous exception. */
	Callback_rt_null,
    /** Pending requests were settled because the session was bound to a new socket. */
    Callback_bindsocket,

    /** Request serialization, size validation, or synchronous transport sending failed. */
    settleSendFailure,
    /** Upper reserved boundary; allocate application error codes above this value. */
    Max = 100, //自定义的error请从MAX之后开始!
}

/**
 * Returns the built-in error name, or undefined for custom error codes.
 */
export function getErrorEnumString(error: ErrorEnum): string {
	if (error < ErrorEnum.Max) return ErrorEnum[error];
}

//export type PErrorEnum = Promise<ErrorEnum>;
/**
 * RPC result tuple: error code followed by optional result values.
 */
export type FirstErrorRt = [ErrorEnum, ...any];
/**
 * Promise resolving to a complete error-first RPC tuple.
 */
export type PFirstErrorRt = Promise<FirstErrorRt>; // 这个es5 不认识！
/**
 * Completion callback receiving a complete error-first RPC tuple.
 */
export type CallbackFirstError = (rt: FirstErrorRt) => void;
// export type CallbackError = (rt: ErrorEnum) => void;
// export type FunctionRtError = (...args: any[]) => ErrorEnum;
// export type FunctionRtErrorData = (...args: any[]) => FirstErrorRt;
// export type FunctionRtErrorDataPromise = (...args: any[]) => Promise<FirstErrorRt | ErrorEnum>;

/**
 * Ordinary handler receiving unpacked business arguments.
 */
export type EventVoidFunc = (...args: any[]) => void;
/**
 * RPC return value: error code, error-first tuple, or a promise of either.
 */
export type EventReturn = ErrorEnum|FirstErrorRt|Promise<FirstErrorRt | ErrorEnum>;
/**
 * RPC handler receiving unpacked arguments and returning an error-first result.
 */
export type EventRtFunc = (...args: any[]) => EventReturn;
