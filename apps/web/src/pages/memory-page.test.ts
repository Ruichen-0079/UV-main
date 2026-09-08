import { expect, it } from "vitest";
import { emptyMemoryForm, toCreateMemoryRequest } from "./memory-page.js";
it("creation sends the editable emotion metadata rather than silently using backend defaults", () => {
  const request = toCreateMemoryRequest({ ...emptyMemoryForm(), content: "Synthetic garden", emotionValence: "-0.4", emotionArousal: "0.7" });
  expect(request).toMatchObject({ content: "Synthetic garden", emotionValence: -0.4, emotionArousal: 0.7 });
});
