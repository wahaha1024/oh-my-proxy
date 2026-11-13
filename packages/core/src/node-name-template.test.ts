import { describe, expect, it } from "vitest";
import { DEFAULT_NODE_NAME_TEMPLATE, formatNodeNameFromTemplate } from "./node-name-template";

describe("formatNodeNameFromTemplate", () => {
  it("prefixes the generated display name without adding separators", () => {
    expect(
      formatNodeNameFromTemplate({
        originName: " Alpha ",
        tag: " HK ",
        template: "[{tag}]{name}",
        prefix: " A-",
      })
    ).toBe("A-[HK]Alpha");

    expect(formatNodeNameFromTemplate({ originName: "Alpha", tag: "", prefix: "T-" })).toBe("T-Alpha");
  });

  it("leaves output unchanged for blank or missing prefixes", () => {
    const params = { originName: "Alpha", tag: "HK", template: DEFAULT_NODE_NAME_TEMPLATE };
    const baseline = formatNodeNameFromTemplate(params);

    expect(formatNodeNameFromTemplate({ ...params, prefix: "" })).toBe(baseline);
    expect(formatNodeNameFromTemplate({ ...params, prefix: "   " })).toBe(baseline);
    expect(formatNodeNameFromTemplate({ originName: "Alpha", tag: "", prefix: "  " })).toBe("Alpha");
  });
});
