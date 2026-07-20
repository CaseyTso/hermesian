import { describe, expect, it } from "vitest";

import { findExternalLinks } from "../src/external-links";

describe("findExternalLinks", () => {
  it("finds explicit, www, and bare-domain web links", () => {
    expect(
      findExternalLinks(
        "See https://example.com/a, www.example.org/docs and github.com/CaseyTso/hermesian.",
      ),
    ).toEqual([
      {
        end: 25,
        href: "https://example.com/a",
        start: 4,
        text: "https://example.com/a",
      },
      {
        end: 47,
        href: "https://www.example.org/docs",
        start: 27,
        text: "www.example.org/docs",
      },
      {
        end: 81,
        href: "https://github.com/CaseyTso/hermesian",
        start: 52,
        text: "github.com/CaseyTso/hermesian",
      },
    ]);
  });

  it("keeps nested accelerator URLs as one clickable target", () => {
    const text = "git clone https://ghfast.top/https://github.com/BioTender-max/awesome-bio-agent-skills.git";
    expect(findExternalLinks(text)).toEqual([
      {
        end: text.length,
        href: "https://ghfast.top/https://github.com/BioTender-max/awesome-bio-agent-skills.git",
        start: 10,
        text: "https://ghfast.top/https://github.com/BioTender-max/awesome-bio-agent-skills.git",
      },
    ]);
  });

  it("trims sentence punctuation and unmatched closing delimiters", () => {
    expect(findExternalLinks("链接（https://example.com/path）。")).toEqual([
      {
        end: 27,
        href: "https://example.com/path",
        start: 3,
        text: "https://example.com/path",
      },
    ]);
  });

  it("does not link emails, local filenames, or unsafe protocols", () => {
    expect(
      findExternalLinks(
        "mail user@example.com; files bioskill_index_v2.csv and note.md; javascript:alert(1)",
      ),
    ).toEqual([]);
  });
});
