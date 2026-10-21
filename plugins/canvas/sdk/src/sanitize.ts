import DOMPurify from "dompurify";
import { marked } from "marked";

export function sanitizeSvg(source: string) {
  return DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      "foreignObject",
      "script",
      "style",
      "animate",
      "animateMotion",
      "animateTransform",
      "set",
      "use",
      "image",
      "a",
    ],
    FORBID_ATTR: ["style", "href", "xlink:href"],
  });
}

export function renderSafeMarkdown(source: string) {
  return DOMPurify.sanitize(marked.parse(source, { async: false }), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "form",
      "input",
      "button",
      "iframe",
      "object",
      "embed",
      "svg",
      "math",
    ],
    FORBID_ATTR: ["style"],
  });
}
