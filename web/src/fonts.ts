import "@fontsource/pacifico/latin-400.css";
import "@fontsource/press-start-2p/latin-400.css";
import "@fontsource/orbitron/latin-400.css";
import "@fontsource/lobster/latin-400.css";
import "@fontsource/caveat/latin-400.css";
import "@fontsource/playfair-display/latin-400.css";
import "@fontsource/bebas-neue/latin-400.css";
import "@fontsource/fira-code/latin-400.css";

export type NameFont = "default" | "serif" | "mono" | "handwriting" | "script" | "display" | "retro" | "techno" | "elegant" | "impact";
export const NAME_FONTS: { id: NameFont; label: string }[] = [
  { id: "default", label: "Standard" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Monospace" },
  { id: "handwriting", label: "Handwriting" },
  { id: "script", label: "Script" },
  { id: "display", label: "Bold script" },
  { id: "retro", label: "Pixel" },
  { id: "techno", label: "Techno" },
  { id: "elegant", label: "Elegant" },
  { id: "impact", label: "Tall" },
];
