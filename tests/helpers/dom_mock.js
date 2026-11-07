const fs = require('node:fs');
const path = require('node:path');

const POPUP_HTML_PATH = path.resolve(__dirname, '../../chrome_extension/popup.html');
const POPUP_HTML = fs.readFileSync(POPUP_HTML_PATH, 'utf8');

function decodeEntities(str) {
  return String(str)
    .replace(/&times;/g, '×')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function stripTagsToText(html) {
  return decodeEntities(String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

class MockClassList {
  constructor(element, initial = '') {
    this._el = element;
    this._set = new Set(initial.split(/\s+/).filter(Boolean));
  }
  _syncFromAttr(val) {
    this._set = new Set(String(val || '').split(/\s+/).filter(Boolean));
  }
  _syncToAttr() {
    this._el._attributes.set('class', Array.from(this._set).join(' '));
  }
  add(...tokens) {
    tokens.forEach(t => { if (t) this._set.add(t); });
    this._syncToAttr();
  }
  remove(...tokens) {
    tokens.forEach(t => this._set.delete(t));
    this._syncToAttr();
  }
  contains(token) {
    return this._set.has(token);
  }
  toggle(token, force) {
    if (force === true || (force === undefined && !this._set.has(token))) {
      this._set.add(token);
      this._syncToAttr();
      return true;
    }
    this._set.delete(token);
    this._syncToAttr();
    return false;
  }
  toString() {
    return Array.from(this._set).join(' ');
  }
}

class MockElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName || 'DIV').toUpperCase();
    this.ownerDocument = ownerDocument;
    this._attributes = new Map();
    this.classList = new MockClassList(this);
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.disabled = false;
    this.checked = false;
    this.placeholder = '';
    this._textContent = '';
    this._innerHTML = '';
    this._listeners = new Map();
  }

  get id() {
    return this._attributes.get('id') || '';
  }
  set id(val) {
    this.setAttribute('id', val);
  }

  get className() {
    return this.classList.toString();
  }
  set className(val) {
    this.classList._syncFromAttr(val);
    this._attributes.set('class', this.classList.toString());
  }

  get title() {
    return this._attributes.get('title') || '';
  }
  set title(val) {
    this.setAttribute('title', val);
  }

  get textContent() {
    if (this.children.length > 0 && !this._textContent) {
      return this.children.map(c => c.textContent).join('');
    }
    return this._textContent;
  }
  set textContent(val) {
    this.children = [];
    this._textContent = val === null || val === undefined ? '' : String(val);
    this._innerHTML = this._textContent;
  }

  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    const str = html === null || html === undefined ? '' : String(html);
    this._innerHTML = str;
    this.children = [];
    if (!str.trim()) {
      this._textContent = '';
      return;
    }
    this._textContent = stripTagsToText(str);
    const parsedChildren = parseHtmlFragment(str, this.ownerDocument);
    for (const child of parsedChildren) {
      this.appendChild(child);
    }
  }

  getAttribute(name) {
    const val = this._attributes.get(name);
    return val !== undefined ? val : null;
  }
  setAttribute(name, value) {
    const strVal = String(value);
    this._attributes.set(name, strVal);
    if (name === 'class') {
      this.classList._syncFromAttr(strVal);
    } else if (name === 'checked') {
      this.checked = true;
    } else if (name === 'disabled') {
      this.disabled = true;
    } else if (name === 'placeholder') {
      this.placeholder = strVal;
    }
  }
  hasAttribute(name) {
    return this._attributes.has(name);
  }
  removeAttribute(name) {
    this._attributes.delete(name);
    if (name === 'class') {
      this.classList._syncFromAttr('');
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, []);
    }
    this._listeners.get(type).push(listener);
  }

  async trigger(type, eventInit = {}) {
    const handlers = this._listeners.get(type) || [];
    const event = {
      type,
      target: eventInit.target || this,
      currentTarget: this,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...eventInit
    };
    for (const fn of handlers) {
      await fn(event);
    }
  }

  async click() {
    if (this.disabled) return;
    await this.trigger('click', { target: this });
  }

  matchesSelector(selector) {
    const sel = selector.trim();
    if (sel.startsWith('#')) {
      return this.id === sel.slice(1);
    }
    if (sel.startsWith('.')) {
      const classes = sel.slice(1).split('.');
      return classes.every(c => this.classList.contains(c));
    }
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const inner = sel.slice(1, -1);
      const eqIdx = inner.indexOf('=');
      if (eqIdx === -1) {
        return this.hasAttribute(inner);
      }
      const attrName = inner.slice(0, eqIdx).trim();
      const attrVal = inner.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      return this.getAttribute(attrName) === attrVal;
    }
    return this.tagName === sel.toUpperCase();
  }

  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) {
          results.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all.length > 0 ? all[0] : null;
  }
}

const VOID_TAGS = new Set([
  'AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT',
  'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR', 'CIRCLE',
  'LINE', 'PATH', 'POLYLINE', 'RECT'
]);

function parseAttributes(attrString, el) {
  const attrRegex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRegex.exec(attrString)) !== null) {
    const name = match[1];
    const rawVal = match[2] !== undefined ? match[2] : (match[3] !== undefined ? match[3] : (match[4] !== undefined ? match[4] : ''));
    el.setAttribute(name, decodeEntities(rawVal));
  }
}

function parseHtmlFragment(html, ownerDocument) {
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, '');
  const root = new MockElement('FRAGMENT', ownerDocument);
  const stack = [root];

  const tokenRegex = /<\/?([a-zA-Z0-9-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let match;
  while ((match = tokenRegex.exec(cleanHtml)) !== null) {
    const full = match[0];
    if (match[4] !== undefined) {
      const text = decodeEntities(match[4]);
      if (text.trim() && stack.length > 0) {
        const current = stack[stack.length - 1];
        if (current.children.length === 0) {
          current._textContent = (current._textContent ? current._textContent + ' ' : '') + text.trim();
        }
      }
      continue;
    }

    const isClosing = full.startsWith('</');
    const tagName = match[1].toUpperCase();
    const attrStr = match[2] || '';
    const isSelfClosing = match[3] === '/' || VOID_TAGS.has(tagName);

    if (isClosing) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === tagName) {
          stack.length = i;
          break;
        }
      }
    } else {
      const el = new MockElement(tagName, ownerDocument);
      parseAttributes(attrStr, el);
      stack[stack.length - 1].appendChild(el);
      if (!isSelfClosing) {
        stack.push(el);
      }
    }
  }

  return root.children;
}

function createPopupDocument() {
  const doc = {
    _listeners: new Map(),
    body: null,
    createElement(tagName) {
      return new MockElement(tagName, doc);
    },
    getElementById(id) {
      return doc.body ? doc.body.querySelector(`#${id}`) : null;
    },
    querySelector(selector) {
      return doc.body ? doc.body.querySelector(selector) : null;
    },
    querySelectorAll(selector) {
      return doc.body ? doc.body.querySelectorAll(selector) : [];
    },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) {
        doc._listeners.set(type, []);
      }
      doc._listeners.get(type).push(fn);
    },
    async dispatchDOMContentLoaded() {
      const fns = doc._listeners.get('DOMContentLoaded') || [];
      for (const fn of fns) {
        await fn();
      }
    }
  };

  const bodyMatch = POPUP_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : POPUP_HTML;
  const htmlEl = new MockElement('HTML', doc);
  const bodyEl = new MockElement('BODY', doc);
  doc.documentElement = htmlEl;
  doc.body = bodyEl;
  htmlEl.appendChild(bodyEl);
  const children = parseHtmlFragment(bodyHtml, doc);
  for (const child of children) {
    bodyEl.appendChild(child);
  }

  return doc;
}

module.exports = {
  createPopupDocument,
  MockElement
};
