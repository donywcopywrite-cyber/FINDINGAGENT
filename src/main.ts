import { tool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { webSearchTool } from "@openai/agents-openai";
import { z } from "zod";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

// ---------- Tools ----------
const normalizeAndDedupeListings = tool({
  name: "normalizeAndDedupeListings",
  description: "Normalize listings, dedupe by MLS, cap to 12.",
  parameters: z.object({
    listings: z.array(z.record(z.any())),
  }),
  execute: async (input: { listings: Record<string, any>[] }) => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const it of input.listings ?? []) {
      const mls = it.mls ?? it.MLS ?? "MLS non trouvé / MLS not found";
      const key = mls !== "MLS non trouvé / MLS not found" ? `MLS:${mls}` : it.url ?? "";
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        mls,
        url: it.url ?? null,
        address: it.address ?? null,
        price: Number(it.price) || null,
        beds: it.beds ?? null,
        baths: it.baths ?? null,
        type: it.type ?? null,
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
    const mlsMatch = input.html.match(/MLS[®™]?\s*#?\s*[:\-]?\s*([A-Z0-9\-]+)/i);
    const priceMatch = input.html.match(/\$\s*[0-9][0-9,.\s]*/);
    return {
      mls: mlsMatch?.[1] ?? "MLS non trouvé / MLS not found",
      url: input.url,
      price: priceMatch ? Number(priceMatch[0].replace(/[^\d]/g, "")) : null,
    };
  },
});

const fetchHtmlPage = tool({
  name: "fetchHtmlPage",
  description: "Fetch HTML page with retries.",
  parameters: z.object({ url: z.string() }),
  execute: async (input: { url: string }) => {
    try {
      const res = await fetch(input.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      const html = await res.text();
      return { url: input.url, html };
    } catch {
      return { url: input.url, html: "" };
    }
  },
});

const searchRealEstateListings = tool({
  name: "searchRealEstateListings",
  description: "Search listing URLs via SerpAPI.",
  parameters: z.object({
    q: z.string(),
    num: z.number().int().min(1).max(20).default(10),
  }),
  execute: async (input: { q: string; num: number }) => {
    const key = process.env.SERPAPI_KEY;
    if (!key) return { results: [] };
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google");
    url.searchParams.set("q", input.q);
    url.searchParams.set("num", String(input.num));
    url.searchParams.set("api_key", key);
    const res = await fetch(url);
    const data = await res.json();
    const allowed = ["centris.ca", "realtor.ca", "royallepage.ca", "remax-quebec.com", "duproprio.com"];
    const results = (data.organic_results ?? [])
      .map((r: any) => r.link)
      .filter((u: string) => {
        try {
          const host = new URL(u).hostname;
          return allowed.some((d) => host.endsWith(d));
        } catch {
          return false;
        }
      });
    return { results };
  },
});

const webSearchPreview = webSearchTool({
  searchContextSize: "medium",
  userLocation: { country: "CA", type: "approximate" },
});

// ---------- Guardrails ----------
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

// ---------- Agent ----------
const ListingFinder = new Agent({
  name: "LISITNG FINDER",
  instructions: `You are “Listings Finder”, a bilingual (FR first, then EN) real-estate agent assistant for Québec.
Return 5–12 currently-listed properties (MLS, URL, price, beds, baths, address, note).
Respect site TOS. Output FR first, then EN.`,
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

// ---------- Workflow ----------
type WorkflowInput = { input_as_text: string };

export const runWorkflow = async (workflow: WorkflowInput) =>
  await withTrace("Property matcher", async () => {
    const conversation: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] },
    ];

    const guard = await runGuardrails(workflow.input_as_text, guardrailsConfig as any, context as any);
    const hasTrip = (guard ?? []).some((r: any) => r?.tripwireTriggered);
    if (hasTrip) return { blocked: true };

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_68f11ef926888190a3785994ea8530e8052cc039ed15b5be",
      },
    });

    const result = await runner.run(ListingFinder, conversation);
    return {
      output_text: JSON.stringify(result.finalOutput),
      output_parsed: result.finalOutput,
    };
  });
