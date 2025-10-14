import "dotenv/config";
import express from "express";
import routes from "./routes";

// ---------- Config ----------
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: "10mb" }));

// ---------- Rotas ----------
app.use(routes);

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
