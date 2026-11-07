// 零依赖的宽容 XML 解析器：只覆盖 Vivado .xpr 这类机器生成的简单 XML。
// 返回 { name, attrs, children, text } 树；不处理命名空间语义（.xpr 未使用）。

function decodeEntities(s) {
  if (!s || s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(source))) {
    attrs[m[1]] = decodeEntities(m[2] !== undefined ? m[2] : m[3]);
  }
  return attrs;
}

/**
 * 解析 XML 文本为节点树。
 * @returns {{name:'#document', attrs:object, children:Array, text:string}}
 */
export function parseXml(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const pushText = (chunk) => {
    if (!chunk) return;
    const node = stack[stack.length - 1];
    node.text += decodeEntities(chunk);
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(src.slice(i));
      break;
    }
    if (lt > i) pushText(src.slice(i, lt));
    // 注释
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    // CDATA
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const chunk = end === -1 ? src.slice(lt + 9) : src.slice(lt + 9, end);
      const node = stack[stack.length - 1];
      node.text += chunk;
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    // 处理指令 / DOCTYPE
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    // 找标签结束的 '>'，跳过属性值里的引号
    let j = lt + 1;
    let quote = null;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    if (j >= src.length) {
      pushText(src.slice(lt));
      break;
    }
    const raw = src.slice(lt + 1, j);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = j + 1;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)\s*([\s\S]*)$/.exec(body);
    if (!m) {
      i = j + 1;
      continue;
    }
    const node = { name: m[1], attrs: parseAttrs(m[2] || ''), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = j + 1;
  }
  return root;
}

/** 深度优先查找所有指定名字的元素 */
export function findAll(node, name, out = []) {
  if (!node) return out;
  if (node.name === name) out.push(node);
  for (const child of node.children || []) findAll(child, name, out);
  return out;
}

/** 查找第一个指定名字的元素（深度优先） */
export function findFirst(node, name) {
  if (!node) return null;
  if (node.name === name) return node;
  for (const child of node.children || []) {
    const found = findFirst(child, name);
    if (found) return found;
  }
  return null;
}

/** 同一父节点下按名字找子元素 */
export function findChildren(node, name) {
  if (!node) return [];
  return (node.children || []).filter((c) => c.name === name);
}

/** 同一父节点下按名字找第一个子元素 */
export function findChild(node, name) {
  if (!node) return null;
  return (node.children || []).find((c) => c.name === name) || null;
}

/** 读取属性（缺失返回 undefined） */
export function getAttr(node, name) {
  return node && node.attrs ? node.attrs[name] : undefined;
}

/** 取元素的直接文本（去空白） */
export function getText(node) {
  return node && node.text ? node.text.trim() : '';
}

/**
 * 读取 <Option Name="X" Val="Y"/> 列表为对象；同名多个时保留最后一个，
 * 另外提供所有值数组（同名 Option 在 .xpr 中确实会出现，例如 SimTypes）。
 */
export function optionsToObject(parent) {
  const out = {};
  if (!parent) return out;
  for (const child of parent.children || []) {
    if (child.name !== 'Option') continue;
    const name = getAttr(child, 'Name');
    if (!name) continue;
    out[name] = getAttr(child, 'Val');
  }
  return out;
}

/** 同名 Option 的全部值 */
export function optionValues(parent, name) {
  const out = [];
  if (!parent) return out;
  for (const child of parent.children || []) {
    if (child.name === 'Option' && getAttr(child, 'Name') === name) {
      const v = getAttr(child, 'Val');
      if (v !== undefined && v !== '') out.push(v);
    }
  }
  return out;
}
