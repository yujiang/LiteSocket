// 房间, 类似socket.io

import { LiteServerClient } from './LiteServerClient';
import { LiteServer } from './LiteServer';
import { msgData } from '../public/Depends';

/**
 * Process-local member set; each broadcast is encoded once.
 */
export class LiteRoom {
	/**
	 * Human-readable diagnostic label.
	 */
	readonly name: string;
	private clients: Set<LiteServerClient> = new Set();

	man:RoomManager;

	/**
	 * Creates LiteRoom with the supplied dependencies and configuration.
	 * @param name - Diagnostic label.
	 */
	constructor(name: string, man:RoomManager) {
		this.name = name;
		this.man = man;
	}

	/**
	 * Adds local room membership; room managers create missing rooms.
	 * @param client - Server-side connection.
	 */
	join(client: LiteServerClient): void {
		this.clients.add(client);
	}

	/**
	 * Removes room membership; managers delete rooms left empty.
	 * @param client - Server-side connection.
	 */
	leave(client: LiteServerClient): void {
		this.clients.delete(client);
	}

	/**
	 * Encodes once and sends to connected room members, optionally excluding one; direct send errors may propagate.
	 * @param event - Transport category or lifecycle name, as specified by this API.
	 * @param data - Payload; session sending and business dispatch may modify the array in place.
	 * @param exceptClient - Optional member excluded from this broadcast.
	 */
	broadcast(event: string, data: msgData, exceptClient?: LiteServerClient): void {
		const server = this.man.server;
		const message = server.encodeBroadcast(event, data, this.name);
		if (message === undefined) return;
		for (const client of this.clients) {
			if (client === exceptClient) continue;
			if (client.isConnected()) {
				client.wsSend(message);
			}
		}
	}

	/**
	 * Reports whether the collection contains the specified room or connection.
	 * @param client - Server-side connection.
	 */
	has(client: LiteServerClient): boolean {
		return this.clients.has(client);
	}

	/**
	 * Reports whether the room has no members.
	 */
	isEmpty(): boolean {
		return this.clients.size === 0;
	}

	/**
	 * Returns the room member count.
	 */
	size(): number {
		return this.clients.size;
	}

	/**
	 * Returns an iterator over current room members.
	 */
	getClients(): Iterable<LiteServerClient> {
		return this.clients.values();
	}
}

/**
 * Manages local rooms and removes rooms emptied by membership cleanup.
 */
export class RoomManager {
	/**
	 * Owning transport server.
	 */
	server: LiteServer;
	/**
	 * Creates RoomManager with the supplied dependencies and configuration.
	 */
	constructor(server: LiteServer){
		this.server = server;
	}

	private rooms: Map<string, LiteRoom> = new Map();

	/**
	 * Returns the named room, or undefined when absent.
	 * @param roomName - Process-local room name.
	 */
	get(roomName: string): LiteRoom | undefined {
		return this.rooms.get(roomName);
	}

	/**
	 * Reports whether the collection contains the specified room or connection.
	 * @param roomName - Process-local room name.
	 */
	has(roomName: string): boolean {
		return this.rooms.has(roomName);
	}

	/**
	 * Returns an existing room or creates and indexes a new room.
	 * @param roomName - Process-local room name.
	 */
	create(roomName: string): LiteRoom {
		let room = this.rooms.get(roomName);
		if (!room) {
			room = new LiteRoom(roomName, this);
			this.rooms.set(roomName, room);
		}
		return room;
	}

	/**
	 * Adds local room membership; room managers create missing rooms.
	 * @param roomName - Process-local room name.
	 * @param client - Server-side connection.
	 */
	join(roomName: string, client: LiteServerClient): void {
		this.create(roomName).join(client);
	}

	/**
	 * Removes room membership; managers delete rooms left empty.
	 * @param roomName - Process-local room name.
	 * @param client - Server-side connection.
	 */
	leave(roomName: string, client: LiteServerClient): void {
		const room = this.rooms.get(roomName);
		if (!room) return;
		room.leave(client);
		if (room.isEmpty()) {
			this.rooms.delete(roomName);
		}
	}

	/**
	 * Removes a connection from all rooms and deletes rooms left empty.
	 * @param client - Server-side connection.
	 */
	leaveAll(client: LiteServerClient): void {
		for (const [name, room] of this.rooms) {
			room.leave(client);
			if (room.isEmpty()) {
				this.rooms.delete(name);
			}
		}
	}

	/**
	 * Removes a named room without disconnecting members.
	 * @param roomName - Process-local room name.
	 */
	dismiss(roomName: string): void {
		this.rooms.delete(roomName);
	}

	/**
	 * Returns an iterator over current rooms.
	 */
	getAllRooms(): IterableIterator<LiteRoom> {
		return this.rooms.values();
	}
}

