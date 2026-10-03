import { describe, expect, it } from "bun:test";
import { emitCanvas, subscribeCanvas, unsubscribeCanvas } from "./emitter";

// `canvas:render` desapareció en 0.1.5: el canvas dejó de emitir componentes
// sueltos y pasó a un modelo de grafo (`node_add` / `node_update` / `edge_*`),
// que es el que consume la vista de oficina 3D.

describe("canvas emitter", () => {
  it("subscribes and unsubscribes websocket-like objects", () => {
    let received: any = null;
    const ws = {
      send: (data: string) => { received = JSON.parse(data); },
    };

    subscribeCanvas(ws);
    emitCanvas("canvas:node_update", { nodeId: "test", changes: { status: "thinking" } });
    unsubscribeCanvas(ws);

    expect(received).toBeDefined();
    expect(received.type).toBe("canvas:node_update");
  });

  it("stops receiving after unsubscribe", () => {
    let count = 0;
    const ws = {
      send: () => { count++; },
    };

    subscribeCanvas(ws);
    emitCanvas("canvas:node_update", { nodeId: "a", changes: { status: "thinking" } });
    unsubscribeCanvas(ws);
    emitCanvas("canvas:node_update", { nodeId: "b", changes: { status: "idle" } });

    expect(count).toBe(1);
  });
});
