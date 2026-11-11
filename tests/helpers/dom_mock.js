const fs = require('node:fs');
const path = require('node:path');

const POPUP_HTML_PATH = path.resolve(__dirname, '../../chrome_extension/popup.html');

function encodeEntities(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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
    this._innerHTML = encodeEntities(this._textContent);
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
    } else if (name === 'disabled') {
      this.disabled = false;
    } else if (name === 'checked') {
      this.checked = false;
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

  _matchesSingleCompound(compound) {
    let rem = compound.trim();
    if (!rem) return false;

    // Extract attribute selectors: [attr] or [attr="val"]
    const attrChecks = [];
    rem = rem.replace(/\[([^\]]+)\]/g, (_, inner) => {
      const eqIdx = inner.indexOf('=');
      if (eqIdx === -1) {
        attrChecks.push({ name: inner.trim(), val: null });
      } else {
        const attrName = inner.slice(0, eqIdx).trim();
        const attrVal = inner.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        attrChecks.push({ name: attrName, val: attrVal });
      }
      return '';
    });

    for (const chk of attrChecks) {
      if (chk.val === null) {
        if (!this.hasAttribute(chk.name)) return false;
      } else if (this.getAttribute(chk.name) !== chk.val) {
        return false;
      }
    }

    if (!rem) return attrChecks.length > 0;

    // Extract #id
    let idMatch = null;
    rem = rem.replace(/#([a-zA-Z0-9_-]+)/g, (_, idVal) => {
      idMatch = idVal;
      return '';
    });
    if (idMatch !== null && this.id !== idMatch) return false;

    // Extract .class tokens
    const classTokens = [];
    rem = rem.replace(/\.([a-zA-Z0-9_-]+)/g, (_, cls) => {
      classTokens.push(cls);
      return '';
    });
    for (const cls of classTokens) {
      if (!this.classList.contains(cls)) return false;
    }

    // Remaining token, if any, is tag name
    rem = rem.trim();
    if (rem && rem !== '*' && this.tagName !== rem.toUpperCase()) {
      return false;
    }

    return true;
  }

  matchesSelector(selector) {
    const groups = String(selector).split(',');
    return groups.some(group => {
      const parts = group.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return false;
      if (!this._matchesSingleCompound(parts[parts.length - 1])) return false;
      let ancestor = this.parentNode;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (ancestor && typeof ancestor._matchesSingleCompound === 'function' && !ancestor._matchesSingleCompound(parts[i])) {
          ancestor = ancestor.parentNode;
        }
        if (!ancestor || typeof ancestor._matchesSingleCompound !== 'function') {
          return false;
        }
        ancestor = ancestor.parentNode;
      }
      return true;
    });
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
  const popupHtml = fs.readFileSync(POPUP_HTML_PATH, 'utf8');
  const doc = {
    _listeners: new Map(),
    documentElement: null,
    head: null,
    body: null,
    createElement(tagName) {
      return new MockElement(tagName, doc);
    },
    getElementById(id) {
      return doc.documentElement ? doc.documentElement.querySelector(`#${id}`) : null;
    },
    querySelector(selector) {
      return doc.documentElement ? doc.documentElement.querySelector(selector) : null;
    },
    querySelectorAll(selector) {
      return doc.documentElement ? doc.documentElement.querySelectorAll(selector) : [];
    },
    addEventListener(type, fn) {
      if (!doc._listeners.has(type)) {
        doc._listeners.set(type, []);
      }
      doc._listeners.get(type).push(fn);
    },
    async dispatchEvent(eventInit = {}) {
      const type = eventInit.type;
      if (!type) return;
      const fns = doc._listeners.get(type) || [];
      const event = {
        preventDefault: () => {},
        stopPropagation: () => {},
        ...eventInit
      };
      for (const fn of fns) {
        await fn(event);
      }
    },
    async dispatchDOMContentLoaded() {
      await doc.dispatchEvent({ type: 'DOMContentLoaded' });
    }
  };

  const htmlEl = new MockElement('HTML', doc);
  const htmlOpenMatch = popupHtml.match(/<html([^>]*)>/i);
  if (htmlOpenMatch) {
    parseAttributes(htmlOpenMatch[1], htmlEl);
  }

  const headEl = new MockElement('HEAD', doc);
  const headMatch = popupHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  if (headMatch) {
    for (const child of parseHtmlFragment(headMatch[1], doc)) {
      headEl.appendChild(child);
    }
  }

  const bodyEl = new MockElement('BODY', doc);
  const bodyMatch = popupHtml.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    parseAttributes(bodyMatch[1], bodyEl);
    for (const child of parseHtmlFragment(bodyMatch[2], doc)) {
      bodyEl.appendChild(child);
    }
  } else {
    for (const child of parseHtmlFragment(popupHtml, doc)) {
      bodyEl.appendChild(child);
    }
  }

  doc.documentElement = htmlEl;
  doc.head = headEl;
  doc.body = bodyEl;
  htmlEl.appendChild(headEl);
  htmlEl.appendChild(bodyEl);

  return doc;
}

module.exports = {
  createPopupDocument,
  MockElement
};
