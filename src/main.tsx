import { createRoot } from "react-dom/client";
import "./i18n"; // Initialize i18n before anything else
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// After a Vercel deploy that rotates chunk hashes, a browser with a cached
// index.html will request the old (now-missing) chunk URLs. vercel.json's
// catch-all SPA rewrite returns index.html for those 404s; the browser
// executes HTML as JS and crashes with "Unexpected token '<'" — blank screen.
// This handler reloads once per session to fetch fresh index.html + new chunks.
// The sessionStorage flag prevents an infinite reload loop if the new chunk
// is itself missing (genuine deploy failure, not a cache problem).
window.addEventListener("vite:preloadError", () => {
  if (!sessionStorage.getItem("vite_chunk_reload")) {
    sessionStorage.setItem("vite_chunk_reload", "1");
    window.location.reload();
  }
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
