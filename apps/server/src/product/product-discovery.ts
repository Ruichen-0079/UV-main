export type DiscoveredModel = {
  id: string;
  ownedBy?: string | undefined;
};

export async function discoverOpenAiCompatibleModels(input: {
  baseUrl: string;
  apiKey?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ ok: boolean; latencyMs: number; models: DiscoveredModel[]; error?: string }> {
  const started = Date.now();
  const base = input.baseUrl.trim().replace(/\/+$/, "");
  if (!base) {
    return { ok: false, latencyMs: 0, models: [], error: "Base URL is required." };
  }
  const url = `${base}/models`;
  try {
    const init: RequestInit = {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      }
    };
    if (input.signal) init.signal = input.signal;
    const response = await fetch(url, init);
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        models: [],
        error: `Model discovery failed (${response.status}).`
      };
    }
    const body = (await response.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
    const models = (body.data ?? [])
      .map((item) => ({
        id: item.id?.trim() ?? "",
        ...(item.owned_by ? { ownedBy: item.owned_by } : {})
      }))
      .filter((item) => item.id.length > 0)
      .slice(0, 200);
    return { ok: true, latencyMs, models };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models: [],
      error: error instanceof Error ? error.message : "Model discovery failed."
    };
  }
}

export async function probeHttpEndpoint(input: {
  url: string;
  apiKey?: string | undefined;
  signal?: AbortSignal | undefined;
}): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
  const started = Date.now();
  try {
    const init: RequestInit = {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      }
    };
    if (input.signal) init.signal = input.signal;
    const response = await fetch(input.url, init);
    return {
      ok: response.ok,
      latencyMs: Date.now() - started,
      status: response.status,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` })
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Connection failed."
    };
  }
}
