export class EventEmitter<Event extends string, Args extends unknown[]> {
	private listeners = new Map<Event, Array<(...args: Args) => void>>();

	on(event: Event, listener: (...args: Args) => void): this {
		const listeners = this.listeners.get(event) ?? [];
		listeners.push(listener);
		this.listeners.set(event, listeners);
		return this;
	}

	emit(event: Event, ...args: Args): boolean {
		const listeners = this.listeners.get(event);
		if (!listeners?.length) return false;
		for (const listener of listeners.slice()) listener(...args);
		return true;
	}

	removeAllListeners(event?: Event): this {
		if (event === undefined) this.listeners.clear();
		else this.listeners.delete(event);
		return this;
	}
}
