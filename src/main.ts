import { tool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";

// ---------- tiny helpers ----------
const toInt = (v: any) => {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const toPrice = (s: any) => {
  if (!s) return null;
  const n = Number(String(s).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const stripScriptsStyles = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ")
    .trim();

// ---------- OUTPUT SCHEMA ----------
const ResultsSchema = z
  .object({
    listings: z.array(
      z
        .object({
          mls: z.string().nullable(),
          url: z.string().nullable(),
          address: z.string().nullable(),
          price: z.number().nullable(),
          beds: z.number().nullable(),
          baths: z.number().nullable(),
          type: z.string().nullable(),
          note_fr: z.string().nullable(),
          note_en: z.string().nullable(),
        })
        .strict()
    ),
  })
  .strict();

// ---------- TOOLS (required-but-nullable; no .optional()) ----------
const normalizeAndDedupeListings = tool({
  name: "normalizeAndDedupeListings",
  description: "Normalize listings, dedupe by MLS (or URL), cap to 12.",
  parameters: z
    .object({
      listings: z.array(
        z
          .object({
            mls: z.string().nullable(),
            url: z.string().nullable(),
            address: z.string().nullable(),
            price: z.number().nullable(),
            beds: z.number().nullable(),
            baths: z.number().nullable(),
            type: z.string().nullable(),
            note_fr: z.string().nullable(),
            note_en: z.string().nullable(),
          })
          .strict()
      ),
    })
    .strict(),
  execute: async (input: { listings: Array<Record<string, any>> }) => {
    const seen = new Set<string>();
    const out: any[] = [];

    for (const it of input.listings ?? []) {
      const rawMls =
        (it.mls ?? it.MLS ?? it.listingId ?? (it as any)["MLS®"])?.toString()?.trim() || null;
      const mls = rawMls || "MLS non trouvé / MLS not found";
      const key = rawMls ? `MLS:${rawMls}` : it.url ? `URL:${it.url}` : "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);

      out.push({
        mls,
        url: it.url ?? null,
        address: it.address ?? null,
        price:
        it.price != null
          ? Number(it.price)
          : toPrice((it as any).priceText ?? (it as any).price_str ?? (it as any).askingPrice),
        beds: toInt(it.beds),
        baths: toInt(it.baths),
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
  description: "Extract MLS, price, beds, baths from supplied HTML.",
  parameters: z
    .object({
      url: z.string().nullable(),
      html: z.string(), // required non-null
    })
    .strict(),
  execute: async (input: { url: string | null; html: string }) => {
    const mls =
      /MLS[®™]?\s*#?\s*[:\-]?\s*([A-Z0-9\-]+)/i.exec(input.html)?.[1] ??
      /Centris\s*#\s*([0-9\-]+)/i.exec(input.html)?.[1] ??
      null;

    const priceMatch = input.html.match(/\$\s*[0-9][0-9,.\s]*/);
    const bedsMatch = input.html.match(/"bedrooms"\s*:\s*(\d+)/i) || input.html.match(/(\d+)\s*beds?/i);
    const bathsMatch =
      input.html.match(/"bathrooms"\s*:\s*(\d+(\.\d+)?)/i) || input.html.match(/(\d+(\.\d+)?)\s*baths?/i);

    return {
      mls: mls ?? "MLS non trouvé / MLS not found",
      url: input.url,
      address: null,
      price: priceMatch ? toPrice(priceMatch[0]) : null,
      beds: bedsMatch ? toInt(bedsMatch[1]) : null,
      baths: bathsMatch ? toInt(bathsMatch[1]) : null,
      type: null,
      note_fr: null,
      note_en: null,
    };
  },
});

const fetchHtmlPage = tool({
  name: "fetchHtmlPage",
  description:
    "Fetch an HTML page (returns at most 2000 chars, scripts/styles removed) to prevent token bloat.",
  parameters: z.object({ url: z.string() }).strict(),
  execute: async (input: { url: string }) => {
    try {
      const res = await fetch(input.url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const raw = await res.text();
      const slim = stripScriptsStyles(raw).slice(0, 2000); // hard cap
      return { url: input.url, html: slim };
    } catch {
      return { url: input.url, html: "" };
    }
  },
});

const searchRealEstateListings = tool({
  name: "searchRealEstateListings",
  description:
    "Use SerpAPI to get candidate listing URLs (filtered by domain). Returns at most 3 URLs.",
  parameters: z
    .object({
      q: z.string(),
      num: z.number().int().min(1).max(3).default(3),
    })
    .strict(),
  execute: async (input: { q: string; num: number }) => {
    const key = process.env.SERPAPI_KEY;
    if (!key) return { q: input.q, num: input.num, results: [] };

    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google");
    u.searchParams.set("q", input.q);
    u.searchParams.set("num", String(Math.min(3, input.num)));
    u.searchParams.set("hl", "fr");
    u.searchParams.set("gl", "ca");
    u.searchParams.set("api_key", key);

    const r = await fetch(u.toString());
    if (!r.ok) return { q: input.q, num: input.num, results: [] };
    const data = await r.json();

    const allowed = ["centris.ca", "realtor.ca", "royallepage.ca", "remax-quebec.com", "duproprio.com"];
    const results: string[] = [];
    for (const item of data.organic_results ?? []) {
      const link = item.link;
      if (!link) continue;
      try {
        const host = new URL(link).hostname.toLowerCase();
        if (allowed.some((d) => host === d || host.endsWith("." + d))) results.push(link);
        if (results.length >= 3) break;
      } catch {}
    }
    return { q: input.q, num: Math.min(3, input.num), results };
  },
});

// ---------- AGENT ----------
const agent = new Agent({
  name: "LISTING FINDER (bounded turns)",
  instructions: `FR d'abord, puis EN. Ne pose PAS de questions de clarification.
Si des infos manquent, fais des hypothèses raisonnables et continue.
Par défaut: ville = Laval, QC; type = condo; chambres = 2+; prix max = 600000 CAD.

Objectif: renvoyer 5–8 propriétés actuelles depuis des pages publiques (Centris, Realtor.ca, Royal LePage, RE/MAX Québec, DuProprio).
Pour chaque propriété: mls (ou "MLS non trouvé / MLS not found"), url, address (si visible), price (CAD), beds, baths, type, note_fr et note_en (une ligne).
N'invente pas de prix/adresse; laisse null si non visible.
Dédoublonne par MLS (ou URL si pas d'MLS).

CONTRAINTES STRICTES:
- UTILISE AU MAXIMUM 1 appel de recherche ET 3 pages à analyser puis ARRÊTE.
- SI TU NE PEUX PAS RÉCOLTER ASSEZ D'INFOS, RENVOIE UNE LISTE VIDE PLUTÔT QUE DE CONTINUER.
- NE DÉPASSE PAS 1 PASS de normalisation (normalizeAndDedupeListings).
- Réponds UNIQUEMENT en JSON valide conforme au schéma.`,
  model: "gpt-5",
  tools: [
    searchRealEstateListings,
    fetchHtmlPage,
    extractListingInfo,
    normalizeAndDedupeListings,
  ],
  outputType: ResultsSchema,
  modelSettings: {
    parallelToolCalls: false,
    reasoning: { effort: "low" },
    store: true,
  },
});

// ---------- WORKFLOW ----------
type WorkflowInput = { input_as_text: string };

export const runWorkflow = async (workflow: WorkflowInput) =>
  await withTrace("Property matcher", async () => {
    const conversation: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] },
    ];

    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_68f11ef926888190a3785994ea8530e8052cc039ed15b5be",
      },
      // 👇 Hard cap the dialogue so it cannot loop to 10 turns.
      ...( { maxTurns: 6 } as any ),
    });

    const result = await runner.run(agent, conversation);
    if (!result.finalOutput) throw new Error("Agent result is undefined");

    return {
      output_text: JSON.stringify(result.finalOutput),
      output_parsed: result.finalOutput,
      listings: result.finalOutput.listings ?? [],
    };
  });
