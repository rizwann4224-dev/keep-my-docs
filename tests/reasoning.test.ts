/**
 * Unit tests for the reasoning-depth helpers (run with `npm test`, i.e. Node's
 * built-in test runner + type stripping).
 *
 * These are the exact model ids used by the chains in src/routes/api/study.ts
 * and src/routes/api/public/icap.ts, so a regression here is a live 400.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  effortFor,
  geminiGenerationConfig,
  geminiThinkingConfig,
  groqRequestParams,
  isGemini3Family,
  openAiRequestParams,
  openAiSamplingParams,
  reasoningEffortParam,
  thinkingHeadroom,
} from "../src/lib/reasoning.ts";

const GATEWAY_CHAIN = [
  "google/gemini-3.6-flash",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
];
const GOOGLE_CHAIN = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-latest"];

function withoutEnvOverride<T>(fn: () => T): T {
  const previous = process.env["STUDY_REASONING_EFFORT"];
  delete process.env["STUDY_REASONING_EFFORT"];
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env["STUDY_REASONING_EFFORT"];
    else process.env["STUDY_REASONING_EFFORT"] = previous;
  }
}

test("per-mode effort: marking tasks think deeper than chat", () => {
  withoutEnvOverride(() => {
    assert.equal(effortFor("ask"), "medium");
    assert.equal(effortFor("mark"), "high");
    assert.equal(effortFor("exam"), "high");
    assert.equal(effortFor("challenge"), "high");
    assert.equal(effortFor("insights"), "medium");
  });
});

test("STUDY_REASONING_EFFORT overrides every mode, including off", () => {
  process.env["STUDY_REASONING_EFFORT"] = "xhigh";
  try {
    assert.equal(effortFor("ask"), "xhigh");
    assert.equal(effortFor("mark"), "xhigh");
  } finally {
    delete process.env["STUDY_REASONING_EFFORT"];
  }
  process.env["STUDY_REASONING_EFFORT"] = "off";
  try {
    assert.equal(effortFor("mark"), "off");
    assert.deepEqual(reasoningEffortParam("mark"), {});
    assert.equal(thinkingHeadroom("mark"), 0);
  } finally {
    delete process.env["STUDY_REASONING_EFFORT"];
  }
});

test("model family detection covers both chains", () => {
  assert.equal(isGemini3Family("google/gemini-3.6-flash"), true);
  assert.equal(isGemini3Family("gemini-3.5-flash"), true);
  assert.equal(isGemini3Family("google/gemini-2.5-flash"), false);
  assert.equal(isGemini3Family("google/gemini-2.5-flash-lite"), false);
  assert.equal(isGemini3Family("gemini-flash-latest"), false);
});

test("Gemini 3 gets thinkingLevel, Gemini 2.5 gets thinkingBudget — never both", () => {
  withoutEnvOverride(() => {
    for (const model of [...GATEWAY_CHAIN, ...GOOGLE_CHAIN]) {
      const cfg = geminiThinkingConfig(model, "mark");
      assert.ok(cfg, `expected a thinking config for ${model}`);
      const keys = Object.keys(cfg!);
      assert.equal(keys.length, 1, `${model} must set exactly one thinking key`);
      if (isGemini3Family(model)) {
        assert.deepEqual(cfg, { thinkingLevel: "high" });
      } else {
        assert.deepEqual(cfg, { thinkingBudget: 12_288 });
      }
    }
  });
});

test("thinkingBudget stays inside the documented 2.5 range (0..24576)", () => {
  for (const effort of ["ask", "mark", "exam", "challenge", "insights"] as const) {
    withoutEnvOverride(() => {
      const cfg = geminiThinkingConfig("google/gemini-2.5-flash-lite", effort) as {
        thinkingBudget?: number;
      };
      assert.ok(typeof cfg.thinkingBudget === "number");
      assert.ok(cfg.thinkingBudget! >= 512 && cfg.thinkingBudget! <= 24_576);
    });
  }
});

test("Gemini 3 generationConfig drops the sampling overrides Google warns about", () => {
  withoutEnvOverride(() => {
    const v3 = geminiGenerationConfig("gemini-3.6-flash", "mark");
    assert.deepEqual(v3, { thinkingConfig: { thinkingLevel: "high" } });

    const v25 = geminiGenerationConfig("gemini-flash-latest", "mark");
    // Unversioned aliases are treated as 2.5-style: budget (accepted by Gemini 3
    // too) rather than a level a 2.5 model would reject.
    assert.deepEqual(v25, {
      temperature: 0,
      topP: 0.1,
      thinkingConfig: { thinkingBudget: 12_288 },
    });
  });
});

test("Gemini 2.5 keeps the deterministic sampling the app has always used", () => {
  withoutEnvOverride(() => {
    assert.deepEqual(geminiGenerationConfig("google/gemini-2.5-flash", "ask"), {
      temperature: 0,
      topP: 0.1,
      thinkingConfig: { thinkingBudget: 4_096 },
    });
  });
});

test('explicit "off" removes thinking but keeps sampling (the 400-retry path)', () => {
  withoutEnvOverride(() => {
    assert.deepEqual(geminiGenerationConfig("gemini-3.6-flash", "off"), {});
    assert.deepEqual(geminiGenerationConfig("google/gemini-2.5-flash", "off"), {
      temperature: 0,
      topP: 0.1,
    });
  });
});

test("gateway params: effort tier for every model, sampling only for non-Gemini-3", () => {
  withoutEnvOverride(() => {
    assert.deepEqual(openAiRequestParams("google/gemini-3.6-flash", "mark"), {
      reasoning_effort: "high",
    });
    assert.deepEqual(openAiRequestParams("google/gemini-2.5-flash-lite", "ask"), {
      temperature: 0,
      top_p: 0.1,
      reasoning_effort: "medium",
    });
  });
});

test("sampling-only params (the 400-retry path) never send sampling to Gemini 3", () => {
  withoutEnvOverride(() => {
    assert.deepEqual(openAiSamplingParams("google/gemini-3.6-flash"), {});
    assert.deepEqual(openAiSamplingParams("google/gemini-3.1-pro-preview"), {});
    assert.deepEqual(openAiSamplingParams("google/gemini-2.5-flash"), {
      temperature: 0,
      top_p: 0.1,
    });
  });
});

test("xhigh saturates at high for OpenAI-style providers", () => {
  process.env["STUDY_REASONING_EFFORT"] = "xhigh";
  try {
    assert.deepEqual(reasoningEffortParam("ask"), { reasoning_effort: "high" });
    // ...but the native Gemini tier still maps to its own ceiling.
    assert.deepEqual(geminiThinkingConfig("gemini-3.6-flash", "ask"), { thinkingLevel: "high" });
    assert.deepEqual(geminiThinkingConfig("google/gemini-2.5-flash", "ask"), {
      thinkingBudget: 24_576,
    });
  } finally {
    delete process.env["STUDY_REASONING_EFFORT"];
  }
});

test("Groq: llama gets no reasoning tier, reasoning-capable models do", () => {
  withoutEnvOverride(() => {
    assert.deepEqual(groqRequestParams("llama-3.3-70b-versatile", "mark"), {
      temperature: 0,
      top_p: 0.1,
    });
    assert.deepEqual(groqRequestParams("llama-3.1-8b-instant", "mark"), {
      temperature: 0,
      top_p: 0.1,
    });
    assert.deepEqual(groqRequestParams("qwen3-32b", "mark"), {
      temperature: 0,
      top_p: 0.1,
      reasoning_effort: "high",
    });
  });
});

test("capped-output call sites reserve room for thinking tokens", () => {
  withoutEnvOverride(() => {
    assert.equal(thinkingHeadroom("ask"), 4_096);
    assert.equal(thinkingHeadroom("mark"), 12_288);
  });
});
