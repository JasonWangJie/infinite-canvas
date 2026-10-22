import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";

export const browser = new JSDOM("", { url: "https://canvas.example" }).window;
for (const [name, value] of Object.entries({ window: browser, document: browser.document, localStorage: browser.localStorage, HTMLAnchorElement: browser.HTMLAnchorElement, CustomEvent: browser.CustomEvent, Event: browser.Event })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
