export enum ErrorEnum {
	ErrorOk,
	ErrorError,
	//Error_notdev,
	//Error_notclient,

	Net_notconnect,

    Msg_closed,
	Handle_not_find,

    Callback_timeout,
	Callback_not_find,
	Callback_rt_invalid,
	Callback_filter_null,
	Callback_disconnect,
    Callback_await_error,
	Callback_rt_null,
    Callback_bindsocket,

    settleSendFailure,
    Max = 100, //自定义的error请从MAX之后开始!
}

export type PErrorEnum = Promise<ErrorEnum>;
export type FirstErrorRt = [ErrorEnum, ...any];
export type PFirstErrorRt = Promise<FirstErrorRt>; // 这个es5 不认识！
export type CallbackFirstError = (rt: FirstErrorRt) => void;
export type CallbackError = (rt: ErrorEnum) => void;
// export type FunctionRtError = (...args: any[]) => ErrorEnum;
export type FunctionRtErrorData = (...args: any[]) => FirstErrorRt;
export type FunctionRtErrorDataPromise = (...args: any[]) => Promise<FirstErrorRt | ErrorEnum>;

export function getErrorEnumString(error: ErrorEnum): string {
	return ErrorEnum[error];
}

export type EventVoidFunc = (...args: any[]) => void;
export type EventReturn = ErrorEnum|FirstErrorRt|Promise<FirstErrorRt | ErrorEnum>;
export type EventRtFunc = (...args: any[]) => EventReturn;
