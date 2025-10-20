import { tool, webSearchTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";


// Tool definitions
const normalizeAndDedupeListings = tool({
  name: "normalizeAndDedupeListings",
  description: "Normalize listings, deduplicate by MLS, trim text fields, normalize prices to numbers, and cap results to 12.",
  parameters: z.object({
    listings: z.array()
  }),
  execute: async (input: {listings: array}) => {
    // TODO: Unimplemented
  },
});
const extractListingInfo = tool({
  name: "extractListingInfo",
  description: "Extract MLS or listing ID, address, price, beds, baths, and property type from supplied HTML or a URL for a real estate listing.",
  parameters: z.object({
    url: z.string(),
    html: z.string()
  }),
  execute: async (input: {url: string, html: string}) => {
    // TODO: Unimplemented
  },
});
const fetchHtmlPage = tool({
  name: "fetchHtmlPage",
  description: "Fetch an HTML listing page with desktop User-Agent, timeout, and retries",
  parameters: z.object({
    url: z.string()
  }),
  execute: async (input: {url: string}) => {
    // TODO: Unimplemented
  },
});
const searchRealEstateListings = tool({
  name: "searchRealEstateListings",
  description: "Search for real estate listing URLs from major Canadian platforms using SerpAPI and filter results to allowed domains.",
  parameters: z.object({
    q: z.string(),
    num: z.integer()
  }),
  execute: async (input: {q: string, num: integer}) => {
    // TODO: Unimplemented
  },
});
const webSearchPreview = webSearchTool({
  searchContextSize: "medium",
  userLocation: {
    country: "CA",
    type: "approximate"
  }
})

// Shared client for guardrails and file search
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Guardrails definitions
const guardrailsConfig = {
  guardrails: [
    {
      name: "Moderation",
      config: {
        categories: [
          "sexual/minors",
          "hate/threatening",
          "harassment/threatening",
          "self-harm/instructions",
          "violence/graphic",
          "illicit/violent"
        ]
      }
    },
    {
      name: "Contains PII",
      config: {
        block: true,
        entities: [
          "CREDIT_CARD",
          "US_BANK_NUMBER",
          "US_PASSPORT",
          "US_SSN"
        ]
      }
    }
  ]
};
const context = { guardrailLlm: client };

// Guardrails utils
function guardrailsHasTripwire(results) {
    return (results ?? []).some((r) => r?.tripwireTriggered === true);
}

function getGuardrailSafeText(results, fallbackText) {
    // Prefer checked_text as the generic safe/processed text
    for (const r of results ?? []) {
        if (r?.info && ("checked_text" in r.info)) {
            return r.info.checked_text ?? fallbackText;
        }
    }
    // Fall back to PII-specific anonymized_text if present
    const pii = (results ?? []).find((r) => r?.info && "anonymized_text" in r.info);
    return pii?.info?.anonymized_text ?? fallbackText;
}

function buildGuardrailFailOutput(results) {
    const get = (name) => (results ?? []).find((r) => {
          const info = r?.info ?? {};
          const n = (info?.guardrail_name ?? info?.guardrailName);
          return n === name;
        }),
          pii = get("Contains PII"),
          mod = get("Moderation"),
          jb = get("Jailbreak"),
          hal = get("Hallucination Detection"),
          piiCounts = Object.entries(pii?.info?.detected_entities ?? {})
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => k + ":" + v.length),
          thr = jb?.info?.threshold,
          conf = jb?.info?.confidence;

    return {
        pii: {
            failed: (piiCounts.length > 0) || pii?.tripwireTriggered === true,
            ...(piiCounts.length ? { detected_counts: piiCounts } : {}),
            ...(pii?.executionFailed && pii?.info?.error ? { error: pii.info.error } : {}),
        },
        moderation: {
            failed: mod?.tripwireTriggered === true || ((mod?.info?.flagged_categories ?? []).length > 0),
            ...(mod?.info?.flagged_categories ? { flagged_categories: mod.info.flagged_categories } : {}),
            ...(mod?.executionFailed && mod?.info?.error ? { error: mod.info.error } : {}),
        },
        jailbreak: {
            // Rely on runtime-provided tripwire; don't recompute thresholds
            failed: jb?.tripwireTriggered === true,
            ...(jb?.executionFailed && jb?.info?.error ? { error: jb.info.error } : {}),
        },
        hallucination: {
            // Rely on runtime-provided tripwire; don't recompute
            failed: hal?.tripwireTriggered === true,
            ...(hal?.info?.reasoning ? { reasoning: hal.info.reasoning } : {}),
            ...(hal?.info?.hallucination_type ? { hallucination_type: hal.info.hallucination_type } : {}),
            ...(hal?.info?.hallucinated_statements ? { hallucinated_statements: hal.info.hallucinated_statements } : {}),
            ...(hal?.info?.verified_statements ? { verified_statements: hal.info.verified_statements } : {}),
            ...(hal?.executionFailed && hal?.info?.error ? { error: hal.info.error } : {}),
        },
    };
}
const LisitngFinderSchema = z.object({ beds: z.number(), baths: z.number(), sqft: z.number(), has_pool: z.boolean(), mls_number: z.string(), listing_url: z.string(), address: z.string(), price: z.number() });
const lisitngFinder = new Agent({
  name: "LISITNG FINDER",
  instructions: `You are “Listings Finder”, a bilingual (FR first, then EN) real-estate agent assistant for Québec.

GOAL
- Given search criteria (location, budget, beds/baths, property type, keywords), browse public sites (Centris, Realtor.ca, Royal LePage, RE/MAX Québec, DuProprio) and return 5–12 currently-listed properties.
- For each property, include: MLS/Listing number (if present), URL, address (or building/area label), asking price (CAD), beds, baths, property type, and a one-line note.
- When multiple pages point to the same MLS, **dedupe** by MLS (keep the most complete record).

SAFETY & SOURCES
- Use only public information (no paywalled/forbidden content). Respect site TOS and robots (fetch gently).
- If MLS is not visible on a page, say “MLS non trouvé / MLS not found” instead of hallucinating.
- Never imply MLS/Centris insider access—these are public storefront pages.

STYLE
- Output FR first, then EN. Keep it concise and client-ready.
- If fewer than 3 matches, say so and offer a next step (expand area/price/filters).

The widget is expecting this data format:
{
  title: 'Québec Listings • Annonces Québec',
  criteria: {
    location: 'Montréal, QC',
    priceMin: '',
    priceMax: '',
    beds: '',
    baths: '',
    type: '',
    keywords: '',
  },
  typeOptions: [
    {
      value: '',
      label: 'Any type / Tout type',
    },
    {
      value: 'house',
      label: 'House / Maison',
    },
    {
      value: 'condo',
      label: 'Condo / Copropriété',
    },
    {
      value: 'multiplex',
      label: 'Multiplex / Plex',
    },
    {
      value: 'land',
      label: 'Land / Terrain',
    },
    {
      value: 'commercial',
      label: 'Commercial',
    },
  ],
  bedsOptions: [
    {
      value: '',
      label: 'Beds: Any / Chambres: Peu importe',
    },
    {
      value: '1',
      label: '1+',
    },
    {
      value: '2',
      label: '2+',
    },
    {
      value: '3',
      label: '3+',
    },
    {
      value: '4',
      label: '4+',
    },
    {
      value: '5',
      label: '5+',
    },
  ],
  bathsOptions: [
    {
      value: '',
      label: 'Baths: Any / Salles de bain: Peu importe',
    },
    {
      value: '1',
      label: '1+',
    },
    {
      value: '2',
      label: '2+',
    },
    {
      value: '3',
      label: '3+',
    },
  ],
  hasResults: false,
  resultsJson: '```json\n{\n  \"listings\": [\n    \n  ],\n  \"schema\": {\n    \"mls\": \"string\",\n    \"url\": \"string\",\n    \"price\": \"number (CAD)\",\n    \"note_en\": \"string\",\n    \"note_fr\": \"string\"\n  }\n}\n```',
}


RULES
- Normalize incoming criteria; fill sensible defaults (ex: Laval, QC if missing).
- Prefer pages that (a) look like a listing detail and (b) show an MLS or listing ID.
- Don’t invent prices/addresses—leave null if not visible.
- Never exceed 12 listings unless asked.
`,
  model: "gpt-5",
  tools: [
    normalizeAndDedupeListings,
    extractListingInfo,
    fetchHtmlPage,
    searchRealEstateListings,
    webSearchPreview
  ],
  outputType: LisitngFinderSchema,
  modelSettings: {
    parallelToolCalls: true,
    reasoning: {
      effort: "low",
      summary: "auto"
    },
    store: true
  }
});

type WorkflowInput = { input_as_text: string };


// Main code entrypoint
export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Property matcher", async () => {
    const state = {

    };
    const conversationHistory: AgentInputItem[] = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: workflow.input_as_text
          }
        ]
      }
    ];
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_68f11ef926888190a3785994ea8530e8052cc039ed15b5be"
      }
    });
    const guardrailsInputtext = workflow.input_as_text;
    const guardrailsResult = await runGuardrails(guardrailsInputtext, guardrailsConfig, context);
    const guardrailsHastripwire = guardrailsHasTripwire(guardrailsResult);
    const guardrailsAnonymizedtext = getGuardrailSafeText(guardrailsResult, guardrailsInputtext);
    const guardrailsOutput = (guardrailsHastripwire ? buildGuardrailFailOutput(guardrailsResult ?? []) : { safe_text: (guardrailsAnonymizedtext ?? guardrailsInputtext) });
    if (guardrailsHastripwire) {
      return guardrailsOutput;
    } else {
      const lisitngFinderResultTemp = await runner.run(
        lisitngFinder,
        [
          ...conversationHistory
        ]
      );
      conversationHistory.push(...lisitngFinderResultTemp.newItems.map((item) => item.rawItem));

      if (!lisitngFinderResultTemp.finalOutput) {
          throw new Error("Agent result is undefined");
      }

      const lisitngFinderResult = {
        output_text: JSON.stringify(lisitngFinderResultTemp.finalOutput),
        output_parsed: lisitngFinderResultTemp.finalOutput
      };
    }
  });
}
