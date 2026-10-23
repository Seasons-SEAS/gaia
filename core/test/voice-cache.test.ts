import { afterEach, describe, expect, it, vi } from "vitest";

import { memoryVoiceStore, speakCached, voiceKey } from "../src/voice/elevenlabs";

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

afterEach(() => vi.unstubAllGlobals());

describe("voice take cache", () => {
  it("keys a take by the words actually spoken ($SEAS is said as Seas)", async () => {
    expect(await voiceKey("Hold 10,000 $SEAS.")).toBe(await voiceKey("Hold 10,000 SEAS."));
    expect(await voiceKey("Hold 10,000 $SEAS.")).not.toBe(await voiceKey("Hold 20,000 $SEAS."));
  });

  it("keeps the newest takes within its size limit", async () => {
    const store = memoryVoiceStore(10);
    await store.put("a", bytes("123456"));
    await store.put("b", bytes("123456"));
    expect(await store.get("a")).toBeNull();
    expect(new TextDecoder().decode((await store.get("b"))!)).toBe("123456");
  });

  it("replays a stored take without calling ElevenLabs", async () => {
    const store = memoryVoiceStore();
    await store.put(await voiceKey("No one can mint more $SEAS."), bytes('{"audio_base64":"x"}\n'));
    const fetchSpy = vi.fn(async () => new Response("should not be called", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await speakCached("No one can mint more $SEAS.", "key", store);
    expect(response.headers.get("X-Gaia-Voice")).toBe("cache");
    expect(await response.text()).toBe('{"audio_base64":"x"}\n');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("streams a fresh take to the listener and keeps a copy for next time", async () => {
    const store = memoryVoiceStore();
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"audio_base64":"y"}\n', { status: 200 })));
    const kept: Promise<unknown>[] = [];
    const response = await speakCached("Payouts land every Sunday.", "key", store, (p) => kept.push(p));
    expect(await response.text()).toBe('{"audio_base64":"y"}\n');
    await Promise.all(kept);
    expect(await store.get(await voiceKey("Payouts land every Sunday."))).not.toBeNull();
  });
});
