import { tool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { z } from "zod";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

// ---------- helpers ----------
const numberFromPriceLike = (s?: string | null) => {
  if (!s) return null;
  const raw = s.replace(/[^\d]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

// ---------- tools ----------
const normalizeAndDedupeListings = tool({
  name: "normalizeAndDedupeListings",
  description: "Normalize listings, dedupe by MLS, cap to 12.",
  // IMPORTANT: explicit object schema + strict() -> additionalProperties: false
  parameters: z.object({
    listings: z.array(
      z
        .object({
          mls: z.string().nullable().optional(),
          url: z.string().url().nullable().optional(),
          address: z.string().nullable().optional(),
          price: z.number().nullable().optional(),
          beds: z.number().int().nullable().optional(),
          baths: z.number().nullable().optional(),
          type: z.string().nullable().optional(),
          note_fr: z.string().nullable().optional(),
          note_en: z.string().nullable().optional(),
        })
        .strict()
    ),
  }),
  execute: async (input: { listings: Record<string, any>[] }) => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const it of input.listings ?? []) {
      const mls =
        (it.mls ?? it.MLS ?? it.listingId ?? it["MLS®"])?.toString()?.trim() ||
        "MLS non trouvé / MLS not found";
      const key = mls !== "MLS non trouvé / MLS not found" ? `MLS:${mls}` : it.url ?? "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);

      const price =
        it.price != null
          ? Number(it.price)
          : numberFromPriceLike((it as any).priceText ?? (it as any).price_str ?? (it as any).askingPrice);

      out.push({
        mls,
        url: it.url ?? null,
        address: it.address ?? null,
        price: Number.isFinite(price as number) ? (price as number) : null,
        beds: it.beds != null ? Number(String(it.beds).replace(/[^\d]/g, "")) : null,
        baths: it.baths != null ? Number(String(it.baths).replace(/[^\d.]/g, "")) : null,
        type: it.type ?? null,
        note_fr: it.note_fr ?? null,
        note_en: it.note_en ?? null,
      });

      if (out.length >= 12) break;
    }
    return { listings: out };
  },
});

const extractListingInfo = tool({
  name: "extractListingInfo",
  description: "Extract listing info from HTML or URL.",
  parameters: z.object({ url: z.string(), html: z.string() }),
  execute: async (input: { url: string; html: string }) => {
    const mls =
      /MLS[®™]?\s*#?\s*[:\-]?\s*([A-Z0-9\-]+)/i.exec(input.html)?.[1] ??
      /Centris\s*#\s*([0-9\-]+)/i.exec(input.html)?.[1] ??
      null;
    const priceMatch = input.html.match(/\$\s*[0-9][0-9,.\s]*/);
    const bedsMatch = input.html.match(/"bedrooms"\s*:\s*(\d+)/i) || input.html.match(/(\d+)\s*beds?/i);
    const bathsMatch =
      input.html.match(/"bathrooms"\s*:\s*(\d+(\.\d+)?)/i) ||
      input.html.match(/(\d+(\.\d+)?)\s*baths?/i);

    return {
      mls: mls ?? "MLS non trouvé / MLS not found",
      url: input.url,
      address: null,
      price: priceMatch ? numberFromPriceLike(priceMatch[0]) : null,
      beds: bedsMatch ? Number(String(bedsMatch[1]).replace(/[^\d]/g, "")) : null,
      baths: bathsMatch ? Number(String(bathsMatch[1]).replace(/[^\d.]/g, "")) : null,
      type: null,
    };
  },
});

const fetchHtmlPage = tool({
  name: "fetchHtmlPage",
  description: "Fetch HTML page with desktop UA.",
  parameters: z.object({ url: z.string() }),
  execute: async (input: { url: string }) => {
    try {
      const res = await fetch(input.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!res.ok) throw new Error(String(res.status));
      const html = await res.text();
      return { url: input.url, html };
    } catch {
      return { url: input.url, html: "" };
    }
  },
});

const searchRealEstateListings = tool({
  name: "searchRealEstateListings",
  description: "Search listing URLs via SerpAPI; filter to major CA domains.",
  parameters: z.object({
    q: z.string(),
    num: z.number().int().min(1).max(20).default(10),
  }),
  execute: async (input: { q: string; num: number }) => {
    const key = process.env.SERPAPI_KEY;
    if (!key) return { q: input.q, num: input.num, results: [] };
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", input.q);
    url.searchParams.set("num", String(input.num));
    url.searchParams.set("hl", "fr");
    url.searchParams.set("gl", "ca");
    url.searchParams.set("api_key", key);

    const res = await fetch(url);
    if (!res.ok) return { q: input.q, num: input.num, results: [] };
    const data = await res.json();

    const allowed = ["centris.ca", "realtor.ca", "royallepage.ca", "remax-quebec.com", "duproprio.com"];
    const results: string[] = [];
    for (const r of data.organic_results ?? []) {
      const link = r.link;
      if (!link) continue;
      try {
        const host = new URL(link).hostname.toLowerCase();
        if (allowed.some((d) => host === d || host.endsWith("." + d))) results.push(link);
        if (results.length >= input.num) break;
      } catch {}
    }
    return { q: input.q, num: input.num, results };
  },
});

const webSearchPreview = webSearchTool({
  searchContextSize: "medium",
  userLocation: { country: "CA", type: "approximate" },
});

// ---------- guardrails ----------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const guardrailsConfig = {
  guardrails: [
    {
      name: "Moderation",
      config: { categories: ["sexual/minors", "hate/threatening", "violence/graphic"] },
    },
  ],
};
const context = { guardrailLlm: client };
const guardrailsHasTripwire = (results: any[]) => (results ?? []).some((r) => r?.tripwireTriggered);

// ---------- agent ----------
const ListingFinder = new Agent({
  name: "LISITNG FINDER",
  instructions: `You are “Listings Finder”, a bilingual (FR first, then EN) real-estate agent assistant for Québec.
Return 5–12 current properties with: MLS, URL, address/area, price (CAD), beds, baths, type, one-line note.
If MLS isn't visible, say "MLS non trouvé / MLS not found". Keep concise, FR first then EN.`,
  model: "gpt-5",
  tools: [
    normalizeAndDedupeListings,
    extractListingInfo,
    fetchHtmlPage,
    searchRealEstateListings,
    webSearchPreview,
  ],
  modelSettings: { parallelToolCalls: true, reasoning: { effort: "low" }, store: true },
});

// ---------- workflow ----------
type WorkflowInput = { input_as_text: string };

export const runWorkflow = async (workflow: WorkflowInput) =>
  await withTrace("Property matcher", async () => {
    const conversation: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] },
    ];

    const guard = await runGuardrails(workflow.input_as_text, guardrailsConfig as any, context as any);
    if (guardrailsHasTripwire(guard as any[])) return { blocked: true };

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_68f11ef926888190a3785994ea8530e8052cc039ed15b5be",
      },
    });

    const result = await runner.run(ListingFinder, conversation);
    if (!result.finalOutput) throw new Error("Agent result is undefined");

    return {
      output_text: JSON.stringify(result.finalOutput),
      output_parsed: result.finalOutput,
    };
  });
