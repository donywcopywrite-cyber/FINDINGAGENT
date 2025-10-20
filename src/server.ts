import express from "express";
import { runWorkflow } from "./main.js";

const app = express();
app.use(express.json());

app.get("/", (_, res) => res.send({ ok: true, service: "ListingFinder" }));

app.post("/runWorkflow", async (req, res) => {
  try {
    const result = await runWorkflow(req.body);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
