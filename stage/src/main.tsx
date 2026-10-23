import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/base.css";
import "./styles/gaia-stage.css";

import { GaiaStage } from "./gaia/GaiaStage";

// `/de/gaia`, `/ja` … pick the copy language; GAIA herself answers in the
// languages Core enables (English for now).
const LOCALES = ["en", "ru", "de", "es", "ja"];
const first = location.pathname.split("/").filter(Boolean)[0];
const locale = first && LOCALES.includes(first) ? first : "en";
document.documentElement.lang = locale;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GaiaStage locale={locale} />
  </StrictMode>,
);
