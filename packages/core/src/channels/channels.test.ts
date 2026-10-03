import { describe, expect, it } from "bun:test";
import { ChannelManager } from "./manager";
import { loadConfig } from "../config/loader";

describe("ChannelManager", () => {
  it("creates a channel manager", () => {
    const config = loadConfig();
    const manager = new ChannelManager(config);
    expect(manager).toBeDefined();
  });

  it("has onMessage handler", () => {
    const config = loadConfig();
    const manager = new ChannelManager(config);
    manager.onMessage(async () => {});
    expect(manager).toBeDefined();
  });
});
