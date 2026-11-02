// DOM helpers shared by the renderer modules. Text always goes in as text nodes, never as HTML.

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  // index.html (or the module that created it) declares every id asked for, with the element type the caller names.
  const typed = element as T;
  return typed;
}

/** Builds an element; text children are text nodes, never HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: (string | false | undefined | null | Node)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === 'function') element.addEventListener(name.replace(/^on/, ''), value);
    else if (value === true) element.setAttribute(name, '');
    else if (value !== false) element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === false || child === undefined || child === null) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}
