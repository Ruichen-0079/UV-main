import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DailyStatusDetails } from "./product-daily-status.js";
it("distinguishes external prerequisites, reduced capability and Runtime failure", () => {
  const html = renderToStaticMarkup(
    <DailyStatusDetails
      data={{
        checkedAt: new Date().toISOString(),
        services: [
          { id: "postgres", status: "unavailable", managed: false },
          { id: "ollama", status: "healthy", managed: false },
          { id: "mem0", status: "degraded", managed: true },
          { id: "runtime", status: "unavailable", managed: true }
        ]
      }}
    />
  );
  for (const text of [
    "PostgreSQL: unavailable",
    "Ollama: healthy",
    "Mem0: degraded",
    "Runtime: unavailable",
    "TCP reachability only",
    "external prerequisite",
    "existing installation",
    "restart YUVI"
  ])
    expect(html).toContain(text);
});
