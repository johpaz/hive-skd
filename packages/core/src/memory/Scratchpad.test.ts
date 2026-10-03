process.env.HIVE_DB_PATH = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Scratchpad } from "./Scratchpad";
import { closeHiveDb } from "../storage/hivedb";
import { ensureHiveDb } from "../storage/bootstrap";
import { getScratchpad } from "../agent/conversation-store";

const THREAD = "test-thread";

let pad: Scratchpad;

beforeEach(async () => {
	closeHiveDb();
	await ensureHiveDb();
	pad = new Scratchpad();
});

afterEach(() => {
	closeHiveDb();
});

describe("Scratchpad", () => {
	it("writes and reads a note", async () => {
		await pad.write(THREAD, "test-1", "hello world");
		expect(await pad.read(THREAD, "test-1")).toBe("hello world");
	});

	it("lists notes as key-value map", async () => {
		await pad.write(THREAD, "list-a", "aaa");
		await pad.write(THREAD, "list-b", "bbb");

		const notes = await pad.list(THREAD);
		expect(notes["list-a"]).toBe("aaa");
		expect(notes["list-b"]).toBe("bbb");
	});

	it("deletes a note", async () => {
		await pad.write(THREAD, "to-delete", "delete me");
		await pad.delete(THREAD, "to-delete");
		expect(await pad.read(THREAD, "to-delete")).toBeUndefined();
	});

	it("clear removes all notes for a thread", async () => {
		await pad.write(THREAD, "clear-a", "a");
		await pad.write(THREAD, "clear-b", "b");
		await pad.clear(THREAD);
		expect(Object.keys(await pad.list(THREAD))).toHaveLength(0);
	});

	it("no toca las notas de otros threads", async () => {
		await pad.write("thread-uno", "k", "uno");
		await pad.write("thread-dos", "k", "dos");
		await pad.clear("thread-uno");

		expect(await pad.read("thread-dos", "k")).toBe("dos");
	});

	it("escribe el mismo documento que lee el context compiler", async () => {
		// La clase y `conversation-store` comparten colección e id. Antes la clase
		// guardaba un doc incompleto (sin `source`, `createdAt` ni `seq`), así que
		// una nota escrita por acá se ordenaba mal dentro del prompt.
		await pad.write(THREAD, "compartida", "valor", "test");

		const notes = await getScratchpad(THREAD);
		expect(notes).toEqual([{ key: "compartida", value: "valor" }]);
	});
});
