import { describe, it, expect } from "bun:test";
import { ToolRegistry, defineTool } from "./ToolRegistry";
import { ToolExecutor } from "./ToolExecutor";

describe("defineTool", () => {
	it("creates a tool definition", () => {
		const tool = defineTool({
			name: "hello",
			description: "Say hello",
			execute: async (args: { name?: string }) => ({ greeting: `Hello, ${args.name ?? "world"}!` }),
		});
		expect(tool.name).toBe("hello");
		expect(tool.description).toBe("Say hello");
	});
});

describe("ToolRegistry", () => {
	it("register, get, has", () => {
		const reg = new ToolRegistry();
		const tool = defineTool({
			name: "test",
			description: "a test tool",
			execute: async () => ({ ok: true }),
		});
		reg.register(tool);
		expect(reg.has("test")).toBe(true);
		expect(reg.get("test")).toBe(tool);
		expect(reg.get("nope")).toBeUndefined();
	});

	it("throws on duplicate registration", () => {
		const reg = new ToolRegistry();
		reg.register(defineTool({ name: "dup", description: "", execute: async () => ({}) }));
		expect(() =>
			reg.register(defineTool({ name: "dup", description: "", execute: async () => ({}) }))
		).toThrow("already registered");
	});

	it("lists and categorizes", () => {
		const reg = new ToolRegistry();
		reg.register(defineTool({ name: "a", description: "", category: "web", execute: async () => ({}) }));
		reg.register(defineTool({ name: "b", description: "", category: "fs", execute: async () => ({}) }));
		reg.register(defineTool({ name: "c", description: "", category: "web", execute: async () => ({}) }));
		expect(reg.size()).toBe(3);
		expect(reg.list()).toHaveLength(3);
		expect(reg.getByCategory("web")).toHaveLength(2);
		expect(reg.getNames()).toEqual(["a", "b", "c"]);
	});

	it("merge and clear", () => {
		const a = new ToolRegistry();
		const b = new ToolRegistry();
		a.register(defineTool({ name: "x", description: "", execute: async () => ({}) }));
		b.register(defineTool({ name: "y", description: "", execute: async () => ({}) }));
		a.merge(b);
		expect(a.size()).toBe(2);
		a.clear();
		expect(a.size()).toBe(0);
	});
});

describe("ToolExecutor", () => {
	it("executes a registered tool", async () => {
		const reg = new ToolRegistry();
		reg.register(
			defineTool({
				name: "echo",
				description: "echo args",
				execute: async (args) => args,
			})
		);
		const exec = new ToolExecutor(reg);
		const result = await exec.execute("echo", { msg: "hi" });
		expect(result.toolName).toBe("echo");
		expect(result.result).toEqual({ msg: "hi" });
		expect(result.error).toBeUndefined();
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("returns error for unknown tool", async () => {
		const exec = new ToolExecutor(new ToolRegistry());
		const result = await exec.execute("ghost", {});
		expect(result.error).toBeString();
		expect(result.error).toContain("not found");
	});

	it("executes batch", async () => {
		const reg = new ToolRegistry();
		reg.register(defineTool({ name: "t1", description: "", execute: async () => 1 }));
		reg.register(defineTool({ name: "t2", description: "", execute: async () => 2 }));
		const exec = new ToolExecutor(reg);
		const results = await exec.executeBatch([{ name: "t1", args: {} }, { name: "t2", args: {} }, { name: "nope", args: {} }]);
		expect(results).toHaveLength(3);
		expect(results[0].result).toBe(1);
		expect(results[1].result).toBe(2);
		expect(results[2].error).toBeString();
	});
});
