import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractGuardedCode,
  restoreGuardedCode,
  type GuardedCodeExtraction,
} from "../src/markdown-code-guard";

/** Nonce-qualified ids replaced by a stable token, so assertions stay readable. */
function stable(text: string): string {
  return text
    .replace(
      /<span class="hermesian-code-placeholder-[a-z0-9-]+" data-hermesian-code="[a-z0-9-]+"><\/span>/g,
      '<span data-hermesian-code="ID"></span>',
    )
    .replace(/hermesian-code:[a-z0-9]+(?:-[a-z0-9]+)*/g, "hermesian-code:ID");
}

function extract(text: string): GuardedCodeExtraction {
  const extraction = extractGuardedCode(text);
  return { processedText: stable(extraction.processedText), fragments: extraction.fragments };
}

describe("markdown-code-guard", () => {
  describe("extractGuardedCode", () => {
    it("leaves a message without such code untouched", () => {
      const text = [
        "设置 `timeout=3000`，比较用 `a == b`，箭头函数写成 `() => {}`。",
        "",
        "```python",
        "result = compute()",
        "```",
      ].join("\n");

      expect(extract(text)).toEqual({ processedText: text, fragments: [] });
    });

    it("guards the highlight syntax Dataview misreads as a query", () => {
      // Same shape as the assistant message that produced
      // "Dataview (inline field '=...=='): PARSING FAILED": a table cell
      // that mentions Obsidian's highlight syntax as inline code.
      const text = "| 环节 | 提取文中的 `<mark>...</mark>` 与 `==...==` 高亮词 |";

      const { processedText, fragments } = extract(text);

      expect(fragments).toEqual([
        { id: expect.any(String), kind: "inline", source: "`==...==`", text: "==...==" },
      ]);
      expect(processedText).toBe(
        '| 环节 | 提取文中的 `<mark>...</mark>` 与 <span data-hermesian-code="ID"></span> 高亮词 |',
      );
    });

    it("guards inline code starting with = or $=", () => {
      const cases: Array<[string, string]> = [
        ["`=this.file.name`", "=this.file.name"],
        ['`$= dv.page("Today").file.name`', '$= dv.page("Today").file.name'],
        ["比较运算符 `==`", "=="],
        ["`=>`", "=>"],
      ];

      for (const [text, expected] of cases) {
        const { processedText, fragments } = extract(text);
        expect(fragments, text).toHaveLength(1);
        expect(fragments[0].kind, text).toBe("inline");
        expect(fragments[0].text, text).toBe(expected);
        expect(processedText, text).toContain('<span data-hermesian-code="ID"></span>');
        expect(processedText, text).not.toContain("`");
      }
    });

    it("leaves code Dataview would skip alone", () => {
      // Operators that do not start with `=`, and the empty queries Dataview skips.
      const text = "运算符 `>=` `<=` `!=`，箭头函数 `() => {}`，空查询 `=` `$=` 结束";

      expect(extract(text)).toEqual({ processedText: text, fragments: [] });
    });

    it("shows the same text Markdown shows for the code span", () => {
      const { processedText, fragments } = extract("查询 ` = this.file.name ` 写法");

      expect(fragments[0]).toEqual({
        id: expect.any(String),
        kind: "inline",
        source: "` = this.file.name `",
        text: "= this.file.name",
      });
      expect(processedText).toBe('查询 <span data-hermesian-code="ID"></span> 写法');
    });

    it("guards a double-backtick span that contains a single backtick", () => {
      const { processedText, fragments } = extract("模板 ``=a`b`` 结束");

      expect(fragments[0].text).toBe("=a`b");
      expect(processedText).toBe('模板 <span data-hermesian-code="ID"></span> 结束');
    });

    it("pairs backtick strings the way Markdown does", () => {
      // Runs of another length never close a code span.
      expect(extract("```a``=b`")).toEqual({ processedText: "```a``=b`", fragments: [] });
      expect(extract("`=x``")).toEqual({ processedText: "`=x``", fragments: [] });
    });

    it("ignores backticks inside fenced code", () => {
      const text = [
        "```js",
        "const query = `=template`;",
        "```",
        "",
        "Use `=this.file.name` here.",
      ].join("\n");

      const { processedText, fragments } = extract(text);

      expect(fragments.map((fragment) => fragment.text)).toEqual(["=this.file.name"]);
      expect(processedText).toContain("const query = `=template`;");
      expect(processedText).toBe(
        text.replace("`=this.file.name`", '<span data-hermesian-code="ID"></span>'),
      );
    });

    it("ignores backticks inside fences nested in a list item or a quote", () => {
      const inList = "- item\n\n  ```js\n  x = `=a`\n  ```";
      const inQuote = "> ```\n> `=a`\n> ```";

      expect(extract(inList)).toEqual({ processedText: inList, fragments: [] });
      expect(extract(inQuote)).toEqual({ processedText: inQuote, fragments: [] });
    });

    it("ignores an escaped backtick", () => {
      const text = "\\`=x\\`";

      expect(extract(text)).toEqual({ processedText: text, fragments: [] });
    });

    it("leaves inline code that spans lines alone", () => {
      const text = "text `=a\nb` more";

      expect(extract(text)).toEqual({ processedText: text, fragments: [] });
    });

    it("follows Markdown's pairing across the lines of a paragraph", () => {
      // The stray backtick on the first line closes on the second one, so
      // " =y" is plain text there, not a code span.
      const text = "stray ` backtick\npair ` =y` after";

      expect(extract(text)).toEqual({ processedText: text, fragments: [] });
    });

    it("pairs again after a blank line", () => {
      const { processedText, fragments } = extract("stray ` backtick\n\ntext `=x` more");

      expect(fragments.map((fragment) => fragment.text)).toEqual(["=x"]);
      expect(processedText).toBe('stray ` backtick\n\ntext <span data-hermesian-code="ID"></span> more');
    });

    it("guards a fenced block whose first line starts with =", () => {
      const block = "```text\n==============================\n Title\n==============================\n```";
      const { processedText, fragments } = extract(`Result:\n\n${block}\n\nDone.`);

      expect(fragments).toEqual([
        {
          id: expect.any(String),
          kind: "block",
          source: block,
          text: "==============================\n Title\n==============================",
          language: "text",
        },
      ]);
      expect(processedText).toBe("Result:\n\n<!--hermesian-code:ID-->\n\nDone.");
    });

    it("guards dataview and dataviewjs fenced blocks", () => {
      const cases = [
        "```dataview\nTABLE file.name\n```",
        "```DataView\nTABLE file.name\n```",
        '```dataview title="Books"\nTABLE file.name\n```',
        "```dataviewjs\ndv.list(dv.pages())\n```",
        "~~~dataviewjs\ndv.list(dv.pages())\n~~~",
      ];

      for (const text of cases) {
        const { processedText, fragments } = extract(text);
        expect(fragments, text).toHaveLength(1);
        expect(fragments[0].kind, text).toBe("block");
        expect(fragments[0].source, text).toBe(text);
        expect(processedText, text).toBe("<!--hermesian-code:ID-->");
      }
    });

    it("leaves ordinary fenced blocks alone", () => {
      const cases = [
        "```sql\nSELECT 1\n```",
        "```text\ndataview TABLE file.name\n```",
        "```dataviewish\nTABLE file.name\n```",
      ];

      for (const text of cases) {
        expect(extract(text), text).toEqual({ processedText: text, fragments: [] });
      }
    });

    it("guards an unclosed fenced block to the end of the message", () => {
      const { processedText, fragments } = extract("Intro\n```dataviewjs\ndv.list()\nstill code");

      expect(fragments).toEqual([
        {
          id: expect.any(String),
          kind: "block",
          source: "```dataviewjs\ndv.list()\nstill code",
          text: "dv.list()\nstill code",
          language: "dataviewjs",
        },
      ]);
      expect(processedText).toBe("Intro\n<!--hermesian-code:ID-->");
    });

    it("keeps a fence opened on the very last line", () => {
      expect(extract("```dataview").fragments).toEqual([
        { id: expect.any(String), kind: "block", source: "```dataview", text: "", language: "dataview" },
      ]);
      expect(extract("```dataview").processedText).toBe("<!--hermesian-code:ID-->");
      expect(extract("text\n```")).toEqual({ processedText: "text\n```", fragments: [] });
    });

    it("lets a shorter fence inside a longer one neither close it nor hide code after it", () => {
      const text = "````\n```\n`=x`\n```\n````\n\nafter `=y`";

      const { processedText, fragments } = extract(text);

      expect(fragments.map((fragment) => fragment.text)).toEqual(["=y"]);
      expect(processedText).toBe(
        "````\n```\n`=x`\n```\n````\n\nafter <span data-hermesian-code=\"ID\"></span>",
      );
    });

    it("keeps the indentation of a fenced block inside a list item", () => {
      const text = "- Example:\n\n  ```dataviewjs\n  dv.list()\n  ```\n\n- Next";

      expect(extract(text).processedText).toBe(
        "- Example:\n\n  <!--hermesian-code:ID-->\n\n- Next",
      );
    });

    it("handles Windows line endings", () => {
      const { processedText, fragments } = extract(
        "```dataviewjs\r\ndv.list()\r\n```\r\n\r\n`=x`\r\n",
      );

      expect(fragments.map((fragment) => fragment.text)).toEqual(["dv.list()", "=x"]);
      expect(processedText).toBe(
        '<!--hermesian-code:ID-->\r\n\r\n<span data-hermesian-code="ID"></span>\r\n',
      );
    });

    it("gives every fragment its own id", () => {
      const { processedText, fragments } = extractGuardedCode("`=a` and `=b`");

      expect(fragments).toHaveLength(2);
      expect(fragments[0].id).not.toBe(fragments[1].id);
      expect(processedText).toContain(`data-hermesian-code="${fragments[0].id}"`);
      expect(processedText).toContain(`data-hermesian-code="${fragments[1].id}"`);
    });
  });

  describe("restoreGuardedCode", () => {
    let window: Window;

    /** happy-dom's element types are cast to the DOM lib's, as the other DOM tests do. */
    function element(tag: string): HTMLElement {
      return window.document.createElement(tag) as unknown as HTMLElement;
    }

    function comment(value: string): Node {
      return window.document.createComment(value) as unknown as Node;
    }

    function text(value: string): Node {
      return window.document.createTextNode(value) as unknown as Node;
    }

    /** Stands in for Obsidian: paragraphs wrap text, raw markup is kept. */
    function render(processedText: string): HTMLElement {
      const container = element("div");
      container.innerHTML = processedText
        .split("\n")
        .map((line) => (line.trim().startsWith("<!--") ? line : line === "" ? "" : `<p>${line}</p>`))
        .join("\n");
      return container;
    }

    beforeEach(() => {
      window = new Window();
      vi.stubGlobal("window", window);
      vi.stubGlobal("document", window.document);
      vi.stubGlobal("HTMLElement", window.HTMLElement);
      vi.stubGlobal("Text", window.Text);
      vi.stubGlobal("Node", window.Node);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("puts inline code back where the placeholder was rendered", () => {
      const { processedText, fragments } = extractGuardedCode("已将选区替换为：`==a highlighted phrase==`。");
      const container = render(processedText);

      restoreGuardedCode(container, fragments);

      expect(container.innerHTML).toBe(
        "<p>已将选区替换为：<code>==a highlighted phrase==</code>。</p>",
      );
    });

    it("puts code back inside a table cell", () => {
      const { processedText, fragments } = extractGuardedCode(
        "| 捕获 | `==...==` 高亮词 |",
      );
      const container = element("div");
      const row = container.appendChild(element("tr"));
      const cell = row.appendChild(element("td"));
      cell.textContent = "与 ";
      cell.insertAdjacentHTML("beforeend", processedText.match(/<span [^>]+><\/span>/)![0]);
      cell.appendChild(text(" 高亮词"));

      restoreGuardedCode(container, fragments);

      expect(cell.innerHTML).toBe("与 <code>==...==</code> 高亮词");
    });

    it("keeps the surrounding emphasis", () => {
      const { fragments } = extractGuardedCode("`=x`");
      const container = element("div");
      container.innerHTML = "<strong><em><span data-hermesian-code=\"X\"></span></em></strong>";
      Object.assign(fragments[0], { id: "X" });

      restoreGuardedCode(container, fragments);

      expect(container.innerHTML).toBe("<strong><em><code>=x</code></em></strong>");
    });

    it("puts a fenced block back as a code block", () => {
      const { processedText, fragments } = extractGuardedCode(
        "Intro\n\n```dataviewjs\ndv.list(dv.pages())\n```\n\nOutro",
      );
      const container = render(processedText);

      restoreGuardedCode(container, fragments);

      const pre = container.querySelector("pre");
      expect(pre?.className).toBe("language-dataviewjs");
      expect(pre?.querySelector("code")?.className).toBe("language-dataviewjs");
      expect(pre?.querySelector("code")?.textContent).toBe("dv.list(dv.pages())\n");
      expect(container.innerHTML).toContain("<p>Intro</p>");
      expect(container.innerHTML).toContain("<p>Outro</p>");
      expect(container.textContent).not.toContain("hermesian-code");
    });

    it("gives a block without a language no language class", () => {
      const { fragments } = extractGuardedCode("```\n= x\n```");
      const container = element("div");
      container.appendChild(comment(`hermesian-code:${fragments[0].id}`));

      restoreGuardedCode(container, fragments);

      expect(container.innerHTML).toBe("<pre><code>= x\n</code></pre>");
    });

    it("replaces a paragraph that only wraps the block placeholder", () => {
      const { fragments } = extractGuardedCode("```dataview\nTABLE\n```");
      const container = element("div");
      container.innerHTML = `<p>  <!--hermesian-code:${fragments[0].id}-->  </p>`;

      restoreGuardedCode(container, fragments);

      expect(container.children).toHaveLength(1);
      expect(container.children[0].tagName).toBe("PRE");
    });

    it("keeps a paragraph that holds more than the placeholder", () => {
      const { fragments } = extractGuardedCode("```dataview\nTABLE\n```");
      const container = element("div");
      container.innerHTML = `<p>before<!--hermesian-code:${fragments[0].id}-->after</p>`;

      restoreGuardedCode(container, fragments);

      expect(container.innerHTML).toBe('<p>before<pre class="language-dataview"><code class="language-dataview">TABLE\n</code></pre>after</p>');
    });

    it("puts the original Markdown back when a placeholder stayed plain text", () => {
      const { fragments } = extractGuardedCode("`=x`");
      const container = element("div");
      container.innerHTML = `<pre><code>a &lt;span class="hermesian-code-placeholder-${fragments[0].id}" data-hermesian-code="${fragments[0].id}"&gt;&lt;/span&gt; b</code></pre>`;

      restoreGuardedCode(container, fragments);

      expect(container.textContent).toBe("a `=x` b");
    });

    it("puts the original block back when its placeholder stayed plain text", () => {
      const { fragments } = extractGuardedCode("```dataview\nTABLE\n```");
      const container = element("div");
      container.textContent = `  <!--hermesian-code:${fragments[0].id}-->`;

      restoreGuardedCode(container, fragments);

      expect(container.textContent).toBe("  ```dataview\nTABLE\n```");
    });

    it("restores several fragments, each in its own place", () => {
      const { processedText, fragments } = extractGuardedCode(
        "Use `=a` then:\n\n```dataview\nTABLE\n```\n\nand `=b`.",
      );
      const container = render(processedText);

      restoreGuardedCode(container, fragments);

      expect(Array.from(container.querySelectorAll("code"), (code) => code.textContent)).toEqual([
        "=a",
        "TABLE\n",
        "=b",
      ]);
      expect(container.querySelector("pre")?.nextElementSibling?.textContent).toBe("and =b.");
    });

    it("carries a class and a data attribute, so either one finds the placeholder", () => {
      const { processedText, fragments } = extractGuardedCode("`=x`");
      const id = fragments[0].id;

      expect(processedText).toBe(
        `<span class="hermesian-code-placeholder-${id}" data-hermesian-code="${id}"></span>`,
      );

      const byClass = element("div");
      byClass.innerHTML = `<p><span class="hermesian-code-placeholder-${id}"></span></p>`;
      restoreGuardedCode(byClass, fragments);
      expect(byClass.innerHTML).toBe("<p><code>=x</code></p>");
    });

    it("keeps code whose placeholder vanished altogether", () => {
      const { fragments } = extractGuardedCode("`=x`\n\n```dataview\nTABLE\n```");
      const container = element("div");
      container.innerHTML = "<p>the renderer dropped everything</p>";

      restoreGuardedCode(container, fragments);

      expect(container.innerHTML).toBe(
        '<p>the renderer dropped everything</p><code>=x</code><pre class="language-dataview"><code class="language-dataview">TABLE\n</code></pre>',
      );
    });

    it("leaves a container alone when there is nothing to restore", () => {
      const container = element("div");
      container.innerHTML = "<p>plain</p>";

      expect(() => restoreGuardedCode(container, [])).not.toThrow();
      expect(container.innerHTML).toBe("<p>plain</p>");
    });
  });
});
