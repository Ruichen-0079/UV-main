import { expect, it } from "vitest";
import { modelEndpoint } from "./product-configuration.js";

it.each([
  ["http://localhost:1234", "http://localhost:1234/v1"],
  ["http://localhost:1234/", "http://localhost:1234/v1"],
  ["https://provider.test/v1/", "https://provider.test/v1"],
  ["https://api.deepinfra.com/v1/openai/", "https://api.deepinfra.com/v1/openai"],
  ["https://provider.test/custom/api", "https://provider.test/custom/api"]
])("resolves the API base %s", (input, expected) => {
  expect(modelEndpoint(input)).toBe(expected);
});
