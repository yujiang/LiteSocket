

type EventReturn = [number, any];
type EventRtFunc = (...args: any[]) => EventReturn;

function t1() : EventReturn {
    return [1, "hello"]
}

function t2(f: EventRtFunc)  {
    return f();
}

function run(){
    t2(t1);
}