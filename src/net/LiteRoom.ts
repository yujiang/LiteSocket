// 房间, 类似socket.io

import { LiteServerClient } from './LiteServerClient';
import { LiteServer } from './LiteServer';
import { msgData } from '../public/Depends';

export class LiteRoom {
	readonly name: string;
	private clients: Set<LiteServerClient> = new Set();

	man:RoomManager;

	constructor(name: string, man:RoomManager) {
		this.name = name;
		this.man = man;
	}

	join(client: LiteServerClient): void {
		this.clients.add(client);
	}

	leave(client: LiteServerClient): void {
		this.clients.delete(client);
	}

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

	has(client: LiteServerClient): boolean {
		return this.clients.has(client);
	}

	isEmpty(): boolean {
		return this.clients.size === 0;
	}

	size(): number {
		return this.clients.size;
	}

	getClients(): Iterable<LiteServerClient> {
		return this.clients.values();
	}
}

export class RoomManager {
	server: LiteServer;
	constructor(server: LiteServer){
		this.server = server;
	}

	private rooms: Map<string, LiteRoom> = new Map();

	get(roomName: string): LiteRoom | undefined {
		return this.rooms.get(roomName);
	}

	has(roomName: string): boolean {
		return this.rooms.has(roomName);
	}

	create(roomName: string): LiteRoom {
		let room = this.rooms.get(roomName);
		if (!room) {
			room = new LiteRoom(roomName, this);
			this.rooms.set(roomName, room);
		}
		return room;
	}

	join(roomName: string, client: LiteServerClient): void {
		this.create(roomName).join(client);
	}

	leave(roomName: string, client: LiteServerClient): void {
		const room = this.rooms.get(roomName);
		if (!room) return;
		room.leave(client);
		if (room.isEmpty()) {
			this.rooms.delete(roomName);
		}
	}

	leaveAll(client: LiteServerClient): void {
		for (const [name, room] of this.rooms) {
			room.leave(client);
			if (room.isEmpty()) {
				this.rooms.delete(name);
			}
		}
	}

	dismiss(roomName: string): void {
		this.rooms.delete(roomName);
	}

	getAllRooms(): IterableIterator<LiteRoom> {
		return this.rooms.values();
	}
}

