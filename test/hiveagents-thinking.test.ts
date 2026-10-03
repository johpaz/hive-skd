/**
 * Provider `hiveagents`: apagar el razonamiento de Qwen3.x.
 *
 * Medido en el servidor del laboratorio: la misma pregunta corta costó 618
 * tokens / 9,9 s con razonamiento y 39 tokens / 0,6 s con
 * `chat_template_kwargs.enable_thinking=false`. El prefijo `/no_think` que se
 * usaba antes no lo respeta Qwen3.6.
 */
import { describe, expect, test } from "bun:test";
import { HiveAgentsProvider } from "../packages/core/src/agent/llm-providers/hiveagents";

const modify = (model: string, thinking?: { enabled: boolean }, body: Record<string, unknown> = {}) => {
  const provider = new HiveAgentsProvider() as unknown as {
    _currentModelId: string;
    modifyRequestBody(body: any, options: any): any;
  };
  provider._currentModelId = model;
  return provider.modifyRequestBody({ messages: [], ...body }, { thinking });
};

describe("hiveagents · thinking", () => {
  test("Qwen3.6 con enabled:false envía chat_template_kwargs a nivel superior", () => {
    const body = modify("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", { enabled: false });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.extra_body).toBeUndefined();
  });

  test("conserva otros chat_template_kwargs que ya traiga el cuerpo", () => {
    const body = modify("Qwen3.8-27B-UD-Q4_K_XL.gguf", { enabled: false }, { chat_template_kwargs: { foo: 1 } });
    expect(body.chat_template_kwargs).toEqual({ foo: 1, enable_thinking: false });
  });

  test("con enabled:true o sin la opción no toca el cuerpo (el modelo razona)", () => {
    expect(modify("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", { enabled: true }).chat_template_kwargs).toBeUndefined();
    expect(modify("Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", undefined).chat_template_kwargs).toBeUndefined();
  });

  test("otros modelos no reciben el parámetro", () => {
    expect(modify("DeepSeek-V4-Flash-UD-IQ2_XXS-00001-of-00003.gguf", { enabled: false }).chat_template_kwargs).toBeUndefined();
  });
});
