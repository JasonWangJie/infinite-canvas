import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";

export const browser = new JSDOM("", { url: "https://canvas.example" }).window;
for (const [name, value] of Object.entries({
    window: browser, document: browser.document, localStorage: browser.localStorage,
    __APP_VERSION__: "test", __APP_RELEASES__: [],
    Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, SVGElement: browser.SVGElement,
    HTMLAnchorElement: browser.HTMLAnchorElement, ShadowRoot: browser.ShadowRoot,
    CustomEvent: browser.CustomEvent, Event: browser.Event, MutationObserver: browser.MutationObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
})) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
