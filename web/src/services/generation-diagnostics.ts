export type GenerationRequestMeasurement = { requestId?: string; durationMs: number };

// Call finish after the response body completes (or the request fails), not at headers.
export function startGenerationRequest() {
    const start = performance.now();
    return (requestId?: unknown): GenerationRequestMeasurement => ({
        ...(typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ? { requestId } : {}),
        durationMs: performance.now() - start,
    });
}
