export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = value;
    else if (key === 'selected') node.selected = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : String(child));
  }
  return node;
}

export const badge = (text, tone = 'neutral') => h('span', { class: `badge ${tone}` }, text);

export function panel(title, ...children) {
  return h('section', { class: 'panel' }, h('h3', {}, title), ...children);
}

export function table(headers, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, headers.map((text) => h('th', {}, text)))),
      h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell) => h('td', {}, cell))))),
    ),
  );
}
